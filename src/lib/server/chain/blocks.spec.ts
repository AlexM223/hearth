/**
 * Block read model tests (EXPLORER.md §6/§7 T2) -- mocked Electrum/Core
 * rails, no live node required. Covers the degrade-tier matrix for
 * getBlockDetail (both by-height and by-hash, both rail combos),
 * getBlockTxPage's one-page-only guarantee, and pool attribution wired +
 * null pre-M5.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, closeDb, runMigrations } from '../db/index.js';
import { clearAllCaches } from './cache.js';
import { getBlockDetail, getBlockTxPage, listRecentBlocks, listBlocksBefore, type BlocksNode } from './blocks.js';
import type { RpcCaller } from '../node/core/rpc.js';

const GENESIS_HEADER_HEX =
	'0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';

function coinbaseTx(txid = 'coinbase1', valueBtc = 3.125): unknown {
	return {
		txid,
		hash: txid,
		version: 2,
		size: 200,
		vsize: 150,
		weight: 600,
		locktime: 0,
		vin: [{ coinbase: 'abcd', sequence: 0xffffffff }],
		vout: [{ value: valueBtc, n: 0, scriptPubKey: { asm: '', hex: '', address: 'bc1qminer', type: 'witness_v0_keyhash' } }],
		hex: ''
	};
}

function plainTx(txid: string, parentTxid: string, inBtc: number, outBtc: number): unknown {
	return {
		txid,
		hash: txid,
		version: 2,
		size: 250,
		vsize: 140,
		weight: 560,
		locktime: 0,
		vin: [{ txid: parentTxid, vout: 0, sequence: 0xffffffff }],
		vout: [{ value: outBtc, n: 0, scriptPubKey: { asm: '', hex: '', address: 'bc1qrecipient', type: 'witness_v0_keyhash' } }],
		hex: ''
	};
}

function parentTx(txid: string, valueBtc: number): unknown {
	return {
		txid,
		hash: txid,
		version: 2,
		size: 200,
		vsize: 140,
		weight: 560,
		locktime: 0,
		vin: [],
		vout: [{ value: valueBtc, n: 0, scriptPubKey: { asm: '', hex: '', address: 'bc1qparent', type: 'witness_v0_keyhash' } }],
		hex: ''
	};
}

function mockNode(handlers: Record<string, (params: unknown[]) => unknown>): BlocksNode {
	const call = vi.fn(async (method: string, params: unknown[] = []) => {
		const h = handlers[method];
		if (!h) throw Object.assign(new Error(`no handler for ${method}`), { rpcCode: -5 });
		return h(params);
	});
	const coreRpc: RpcCaller = { call: call as RpcCaller['call'] };
	return {
		electrum: {
			isConnected: false,
			getBlockHeader: vi.fn(async () => {
				throw new Error('electrum down');
			}),
			getBlockHeaders: vi.fn(async () => {
				throw new Error('electrum down');
			})
		},
		coreRpc,
		getTipHeight: vi.fn(async () => 934200)
	};
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	clearAllCaches();
});

describe('chain/blocks: getBlockDetail', () => {
	it('by hash, both rails up: richness full, reward/fee stats populated, pool null pre-M5', async () => {
		const node = mockNode({
			getblock: (params) => {
				const [hash, verbosity] = params as [string, number];
				if (verbosity === 2) {
					return {
						hash,
						height: 934200,
						time: 1_700_000_000,
						confirmations: 1,
						size: 1000,
						strippedsize: 900,
						weight: 3600,
						version: 1,
						versionHex: '00000001',
						merkleroot: 'merkle',
						nonce: 1,
						bits: '1d00ffff',
						difficulty: 1,
						chainwork: 'aa',
						previousblockhash: 'prevhash',
						nextblockhash: 'nexthash',
						tx: [coinbaseTx(), plainTx('tx1', 'parent1', 0.001, 0.0009)]
					};
				}
				throw new Error('unexpected verbosity');
			},
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'parent1') return parentTx('parent1', 0.001);
				throw new Error('unexpected txid');
			}
		});

		const detail = await getBlockDetail(node, 'deadbeefhash');
		expect(detail.richness).toBe('full');
		expect(detail.reward).toBe(312_500_000); // 3.125 BTC in sats
		expect(detail.medianFeeRate).not.toBeNull();
		expect(detail.confirmations).toBe(1); // tip 934200 - height 934200 + 1
		expect(detail.pool).toBeNull(); // pre-M5, no mining_blocks table
	});

	it('by hash, Core down: richness none, never a silent 404 (all nulls, no thrown error)', async () => {
		const node = mockNode({}); // every Core call throws "no handler"
		const detail = await getBlockDetail(node, 'deadbeefhash');
		expect(detail.richness).toBe('none');
		expect(detail.txCount).toBeNull();
		expect(detail.confirmations).toBeNull();
		expect(detail.difficulty).toBeNull();
	});

	it('by height, Core down but Electrum up: richness basic, bare header fields only', async () => {
		const node = mockNode({}); // Core: every call throws
		node.electrum.isConnected = true;
		node.electrum.getBlockHeader = vi.fn(async () => GENESIS_HEADER_HEX);

		const detail = await getBlockDetail(node, 0);
		expect(detail.richness).toBe('basic');
		expect(detail.txCount).toBeNull();
		expect(detail.size).toBeNull();
		expect(detail.confirmations).toBeNull();
		expect(detail.hash).toHaveLength(64);
	});

	it('by height, both rails down: richness none', async () => {
		const node = mockNode({});
		const detail = await getBlockDetail(node, 0);
		expect(detail.richness).toBe('none');
	});
});

describe('chain/blocks: getBlockTxPage', () => {
	it('never resolves more than one page of txs per call', async () => {
		const txids = Array.from({ length: 10 }, (_, i) => `tx${i}`);
		let getrawCalls = 0;
		const node = mockNode({
			getblock: (params) => {
				const [, verbosity] = params as [string, number];
				expect(verbosity).toBe(1);
				return { tx: txids };
			},
			getrawtransaction: (params) => {
				getrawCalls++;
				const [txid] = params as [string];
				return coinbaseTx(txid, 0.001);
			}
		});

		const page = await getBlockTxPage(node, 'somehash', 0, 3);
		expect(page.rows).toHaveLength(3);
		expect(page.txids).toHaveLength(10);
		expect(page.hasMore).toBe(true);
		expect(page.cursor).toBe(3);
		expect(getrawCalls).toBe(3); // exactly the page, never the whole block

		const page2 = await getBlockTxPage(node, 'somehash', page.cursor, 3);
		expect(page2.rows).toHaveLength(3);
		expect(getrawCalls).toBe(6);
	});

	it('a failed row degrades to feeRate:null rather than throwing the whole page', async () => {
		const node = mockNode({
			getblock: () => ({ tx: ['good', 'bad'] }),
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'bad') throw new Error('boom');
				return coinbaseTx('good', 0.001);
			}
		});
		const page = await getBlockTxPage(node, 'hash', 0, 10);
		expect(page.rows.find((r) => r.txid === 'bad')).toEqual({ txid: 'bad', feeRate: null, totalOut: null });
		expect(page.rows.find((r) => r.txid === 'good')?.feeRate).toBeNull(); // coinbase -> null feeRate, not 0
	});
});

describe('chain/blocks: listRecentBlocks', () => {
	it('one bad row degrades to basic, never blanks the whole list', async () => {
		const node = mockNode({
			getblockhash: (params) => {
				const [height] = params as [number];
				return `hash${height}`;
			},
			getblockheader: (params) => {
				const [hash] = params as [string];
				return { hash, time: 1_700_000_000 };
			},
			getblock: (params) => {
				const [hash, verbosity] = params as [string, number];
				if (verbosity !== 2) throw new Error('unexpected verbosity');
				if (hash === 'hash934199') throw new Error('core enrichment failed for this row');
				return {
					hash,
					height: 934200,
					time: 1_700_000_100,
					confirmations: 1,
					size: 1000,
					strippedsize: 900,
					weight: 3600,
					version: 1,
					versionHex: '00000001',
					merkleroot: 'merkle',
					nonce: 1,
					bits: '1d00ffff',
					difficulty: 1,
					chainwork: 'aa',
					tx: [coinbaseTx()]
				};
			}
		});
		node.getTipHeight = vi.fn(async () => 934200);

		const rows = await listRecentBlocks(node, 2);
		expect(rows).toHaveLength(2);
		const bad = rows.find((r) => r.hash === 'hash934199');
		const good = rows.find((r) => r.hash === 'hash934200');
		expect(bad?.richness).toBe('basic');
		expect(bad?.txCount).toBeNull();
		expect(good?.richness).toBe('full');
	});
});

describe('chain/blocks: listBlocksBefore', () => {
	it('returns the `limit` blocks strictly before `beforeHeight`, newest first', async () => {
		const node = mockNode({
			getblockhash: (params) => `hash${(params as [number])[0]}`,
			getblockheader: (params) => ({ hash: (params as [string])[0], time: 1_700_000_000 }),
			getblock: (params) => {
				const [hash] = params as [string];
				throw new Error(`core enrichment down for ${hash}`); // force basic rows -- keep the test cheap
			}
		});
		const rows = await listBlocksBefore(node, 100, 3);
		expect(rows.map((r) => r.hash)).toEqual(['hash99', 'hash98', 'hash97']);
	});

	it('returns [] when beforeHeight is 0 (nothing exists before genesis)', async () => {
		const node = mockNode({});
		const rows = await listBlocksBefore(node, 0, 5);
		expect(rows).toEqual([]);
	});
});
