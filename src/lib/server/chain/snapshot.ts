/**
 * The persisted SWR snapshot for the explorer index (EXPLORER.md §1.8(a),
 * DECISIONS.md §4.8). Single-row upsert-only `explorer_snapshot` (migration
 * 006). `readExplorerSnapshot()` never throws -- a missing row, a parse
 * error, or a wiped/corrupt DB file all read back as `null` and self-heal on
 * the next `refreshExplorerSnapshot()` call with zero special-casing (the
 * wipe-safe contract).
 */
import { getDb } from '../db/index.js';
import { logWarn } from '../log.js';
import { listRecentBlocks, type BlocksElectrumRail } from './blocks.js';
import { getMempoolSummary } from './mempool.js';
import { getFeeRecommendation, type FeesElectrumRail } from './fees.js';
import type { BlockSummary, FeeRecommendation, MempoolSummary } from './types.js';
import type { RpcCaller } from '../node/index.js';

export interface SnapshotData {
	recentBlocks: BlockSummary[];
	mempool: MempoolSummary;
	fees: FeeRecommendation | null; // null when getFeeRecommendation's own total-failure throw fires
}

export interface ExplorerSnapshot {
	data: SnapshotData;
	syncedAt: string;
}

export interface SnapshotNode {
	electrum: BlocksElectrumRail & FeesElectrumRail;
	coreRpc: RpcCaller;
	getTipHeight(): Promise<number | null>;
}

const THROTTLE_MS = 15_000;
const RECENT_BLOCKS_COUNT = 10;

/** Never throws -- any failure (missing row, parse error, wiped/corrupt DB)
 *  reads back as null, identically to "first boot." */
export function readExplorerSnapshot(): ExplorerSnapshot | null {
	try {
		const row = getDb()
			.prepare('SELECT data, synced_at FROM explorer_snapshot WHERE id = 1')
			.get() as { data: string; synced_at: string } | undefined;
		if (!row) return null;
		const data = JSON.parse(row.data) as SnapshotData;
		return { data, syncedAt: row.synced_at };
	} catch (e) {
		logWarn('chain', { event: 'explorer_snapshot_read_failed', err: String(e) });
		return null;
	}
}

function writeSnapshot(data: SnapshotData): void {
	const syncedAt = new Date().toISOString();
	getDb()
		.prepare(
			`INSERT INTO explorer_snapshot (id, data, synced_at) VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at`
		)
		.run(JSON.stringify(data), syncedAt);
}

// Single-flight guard -- concurrent callers share one in-flight fetch (the
// wallet module's syncWallet convention).
let inflight: Promise<ExplorerSnapshot | null> | null = null;

/**
 * Refreshes the snapshot: single-flight, throttled (a snapshot younger than
 * 15s short-circuits unless `force`), partial-success tolerant (each
 * sub-fetch has its own catch already, baked into listRecentBlocks/
 * getMempoolSummary/getFeeRecommendation's own degrade behavior) -- only a
 * TOTAL outage (no blocks, no mempool data, no fee estimate at all) skips
 * the write, and even then the last good snapshot keeps serving.
 */
export async function refreshExplorerSnapshot(
	node: SnapshotNode,
	opts: { force?: boolean } = {}
): Promise<ExplorerSnapshot | null> {
	if (!opts.force) {
		const current = readExplorerSnapshot();
		if (current && Date.now() - new Date(current.syncedAt).getTime() < THROTTLE_MS) {
			return current;
		}
	}
	if (inflight) return inflight;

	inflight = (async (): Promise<ExplorerSnapshot | null> => {
		try {
			const [blocksR, mempoolR, feesR] = await Promise.allSettled([
				listRecentBlocks(node, RECENT_BLOCKS_COUNT),
				getMempoolSummary(node),
				getFeeRecommendation(node)
			]);

			const recentBlocks = blocksR.status === 'fulfilled' ? blocksR.value : [];
			const mempool: MempoolSummary =
				mempoolR.status === 'fulfilled'
					? mempoolR.value
					: { txCount: null, bytes: null, totalFeeSats: null, richness: 'none' };
			const fees = feesR.status === 'fulfilled' ? feesR.value : null;

			const totalOutage = recentBlocks.length === 0 && mempool.richness === 'none' && fees === null;
			if (totalOutage) {
				logWarn('chain', { event: 'explorer_snapshot_total_outage_skipped_write' });
				return readExplorerSnapshot();
			}

			writeSnapshot({ recentBlocks, mempool, fees });
			return readExplorerSnapshot();
		} finally {
			inflight = null;
		}
	})();

	return inflight;
}
