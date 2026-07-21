/**
 * SWR snapshot tests (EXPLORER.md §1.8/§6/§7 T6): wipe-safe self-heal,
 * throttle short-circuit, single-flight under concurrent load, and
 * total-outage-preserves-last-good-snapshot.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { clearAllCaches } from './cache.js';
import { readExplorerSnapshot, refreshExplorerSnapshot, type SnapshotNode } from './snapshot.js';
import type { RpcCaller } from '../node/core/rpc.js';

function mockNode(overrides: Partial<{ call: RpcCaller['call']; tip: number | null }> = {}): {
	node: SnapshotNode;
	callSpy: ReturnType<typeof vi.fn>;
} {
	const callSpy = vi.fn(
		overrides.call ??
			(async (method: string) => {
				if (method === 'getblockchaininfo') return { blocks: 900_000 };
				if (method === 'getmempoolinfo') return { size: 10, bytes: 1000, total_fee: 0.0001 };
				if (method === 'estimatesmartfee') return { feerate: 0.00002, blocks: 6 };
				throw new Error(`no handler for ${method}`);
			})
	);
	const node: SnapshotNode = {
		electrum: {
			isConnected: false,
			getBlockHeader: vi.fn(async () => {
				throw new Error('electrum down');
			}),
			getBlockHeaders: vi.fn(async () => {
				throw new Error('electrum down');
			}),
			estimateFee: vi.fn(async () => -1)
		},
		coreRpc: { call: callSpy as RpcCaller['call'] },
		getTipHeight: vi.fn(async () => overrides.tip ?? 900_000)
	};
	return { node, callSpy };
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	clearAllCaches();
});

describe('chain/snapshot: readExplorerSnapshot (wipe-safe)', () => {
	it('a missing row (first boot, or a wiped table) reads as null, never throws', () => {
		expect(() => readExplorerSnapshot()).not.toThrow();
		expect(readExplorerSnapshot()).toBeNull();
	});

	it('self-heals: a missing row triggers a live fetch + write on refresh', async () => {
		const { node } = mockNode();
		expect(readExplorerSnapshot()).toBeNull();
		const snap = await refreshExplorerSnapshot(node);
		expect(snap).not.toBeNull();
		expect(readExplorerSnapshot()).not.toBeNull();
	});

	it('a corrupt row (unparseable JSON) reads as null, identically to a missing row', () => {
		getDb()
			.prepare('INSERT INTO explorer_snapshot (id, data, synced_at) VALUES (1, ?, ?)')
			.run('{not valid json', new Date().toISOString());
		expect(readExplorerSnapshot()).toBeNull();
	});
});

describe('chain/snapshot: refreshExplorerSnapshot throttle + single-flight', () => {
	it('a fresh (<15s) snapshot short-circuits the fetch unless force', async () => {
		const { node, callSpy } = mockNode();
		await refreshExplorerSnapshot(node, { force: true });
		callSpy.mockClear();

		await refreshExplorerSnapshot(node); // fresh -- should NOT re-fetch
		expect(callSpy).not.toHaveBeenCalled();

		await refreshExplorerSnapshot(node, { force: true }); // force bypasses the throttle
		expect(callSpy).toHaveBeenCalled();
	});

	it('concurrent refreshExplorerSnapshot() calls under load resolve to exactly ONE underlying rail fetch', async () => {
		const { node } = mockNode();
		const results = await Promise.all([
			refreshExplorerSnapshot(node, { force: true }),
			refreshExplorerSnapshot(node, { force: true }),
			refreshExplorerSnapshot(node, { force: true })
		]);
		// every caller gets a snapshot back
		for (const r of results) expect(r).not.toBeNull();
		// getTipHeight is called exactly once per listRecentBlocks invocation,
		// which happens exactly once per FULL refresh -- a direct, unambiguous
		// signal of "how many refreshes actually ran" (unlike 'getmempoolinfo',
		// which legitimately fires twice per single refresh: once from
		// getMempoolSummary, once from getFeeRecommendation's own floor lookup).
		expect(node.getTipHeight).toHaveBeenCalledTimes(1);
	});
});

describe('chain/snapshot: total-outage preserves the last good snapshot', () => {
	it('a simulated total-rail-outage mid-refresh leaves the previous good snapshot intact and readable', async () => {
		const { node } = mockNode();
		await refreshExplorerSnapshot(node, { force: true });
		const goodSnapshot = readExplorerSnapshot();
		expect(goodSnapshot).not.toBeNull();

		const { node: deadNode } = mockNode({
			call: async () => {
				throw new Error('total outage');
			},
			tip: null // listRecentBlocks returns [] when tip is unknown
		});
		const result = await refreshExplorerSnapshot(deadNode, { force: true });

		// the write was skipped -- the OLD good data is still what's stored
		expect(result?.data).toEqual(goodSnapshot?.data);
		expect(readExplorerSnapshot()?.data).toEqual(goodSnapshot?.data);
	});

	it('a partial success (e.g. mempool data but no fee estimate) DOES write -- not a total outage', async () => {
		const { node } = mockNode({
			call: (async (method: string) => {
				if (method === 'getmempoolinfo') return { size: 5, bytes: 500, total_fee: 0.00001 };
				throw new Error('no estimate');
			}) as RpcCaller['call']
		});
		const snap = await refreshExplorerSnapshot(node, { force: true });
		expect(snap?.data.mempool.richness).toBe('full');
		expect(snap?.data.fees).toBeNull(); // fee estimation failed -- honest null, not fabricated
	});
});
