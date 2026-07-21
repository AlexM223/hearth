/**
 * Transaction read model tests (EXPLORER.md §6/§7 T3). Mocked Core RPC,
 * no live node required.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, closeDb, runMigrations } from '../db/index.js';
import { clearAllCaches } from './cache.js';
import { getCpfpInfo, getTxDetail, MAX_PREVOUT_RESOLVE, type TxNode } from './tx.js';
import type { RpcCaller } from '../node/core/rpc.js';

function mockNode(handlers: Record<string, (params: unknown[]) => unknown>, tip: number | null = 900_000): TxNode {
	const call = vi.fn(async (method: string, params: unknown[] = []) => {
		const h = handlers[method];
		if (!h) throw Object.assign(new Error(`no handler for ${method}`), { rpcCode: -5 });
		return h(params);
	});
	return { coreRpc: { call: call as RpcCaller['call'] }, getTipHeight: vi.fn(async () => tip) };
}

function confirmedTx(opts: {
	txid: string;
	vin: { txid?: string; vout?: number; coinbase?: string; sequence?: number; witness?: string[] }[];
	vout: { address?: string; value: number; type?: string }[];
	blockhash?: string;
	confirmations?: number;
	blocktime?: number;
}): unknown {
	return {
		txid: opts.txid,
		hash: opts.txid,
		version: 2,
		size: 250,
		vsize: 140,
		weight: 560,
		locktime: 0,
		vin: opts.vin.map((v) => ({
			txid: v.txid,
			vout: v.vout,
			coinbase: v.coinbase,
			sequence: v.sequence ?? 0xfffffffe,
			txinwitness: v.witness,
			scriptSig: { asm: '', hex: 'deadbeef' }
		})),
		vout: opts.vout.map((v, n) => ({
			value: v.value,
			n,
			scriptPubKey: { asm: '', hex: 'aabb', address: v.address, type: v.type ?? 'witness_v0_keyhash' }
		})),
		hex: '',
		blockhash: opts.blockhash,
		confirmations: opts.confirmations,
		blocktime: opts.blocktime
	};
}

function parentTx(txid: string, value: number): unknown {
	return {
		txid,
		hash: txid,
		version: 2,
		size: 200,
		vsize: 140,
		weight: 560,
		locktime: 0,
		vin: [],
		vout: [{ value, n: 0, scriptPubKey: { asm: '', hex: '', address: 'bc1qparent', type: 'witness_v0_keyhash' } }],
		hex: ''
	};
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	clearAllCaches();
});

describe('chain/tx: getTxDetail', () => {
	it('a confirmed tx with a resolvable prevout: honest fee/feeRate, full block context', async () => {
		const node = mockNode({
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'child')
					return confirmedTx({
						txid: 'child',
						vin: [{ txid: 'parent', vout: 0 }],
						vout: [{ address: 'bc1qrecipient', value: 0.0009 }],
						blockhash: 'blockhash1',
						confirmations: 3,
						blocktime: 1_700_000_000
					});
				if (txid === 'parent') return parentTx('parent', 0.001);
				throw new Error('unexpected txid');
			},
			getblockheader: () => ({ height: 899_998 }),
			gettxout: () => null // the single output is already spent in this fixture
		});

		const detail = await getTxDetail(node, 'child');
		expect(detail.confirmed).toBe(true);
		expect(detail.confirmations).toBe(3);
		expect(detail.blockHeight).toBe(899_998);
		expect(detail.fee).toBe(10_000); // 0.001 - 0.0009 BTC = 10_000 sats
		expect(detail.feeRate).toBeCloseTo(10_000 / 140, 5);
		expect(detail.blockContext).toEqual({
			richness: 'full',
			confirmed: true,
			height: 899_998,
			confirmations: 3,
			tipHeight: 900_000
		});
		expect(detail.cpfp).toBeNull(); // confirmed -- never computed
		expect(detail.vin[0]).toEqual({
			txid: 'parent',
			vout: 0,
			coinbase: false,
			address: 'bc1qparent',
			value: 100_000,
			scriptSigHex: 'deadbeef',
			witness: null
		});
	});

	it('fee/feeRate are null when a prevout fails to resolve (never fabricated)', async () => {
		const node = mockNode({
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'child')
					return confirmedTx({
						txid: 'child',
						vin: [{ txid: 'missingparent', vout: 0 }],
						vout: [{ address: 'bc1qrecipient', value: 0.0009 }],
						blockhash: 'blockhash1',
						confirmations: 1
					});
				throw Object.assign(new Error('not found'), { rpcCode: -5 });
			},
			getblockheader: () => ({ height: 899_999 }),
			gettxout: () => null
		});

		const detail = await getTxDetail(node, 'child');
		expect(detail.fee).toBeNull();
		expect(detail.feeRate).toBeNull();
	});

	it('fee/feeRate are null when a tx has more inputs than MAX_PREVOUT_RESOLVE -- never a partial sum', async () => {
		const manyVin = Array.from({ length: MAX_PREVOUT_RESOLVE + 1 }, (_, i) => ({ txid: `p${i}`, vout: 0 }));
		const node = mockNode({
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'child')
					return confirmedTx({
						txid: 'child',
						vin: manyVin,
						vout: [{ address: 'bc1qrecipient', value: 0.0009 }],
						blockhash: 'blockhash1',
						confirmations: 1
					});
				return parentTx(txid, 0.0001); // every parent WOULD resolve fine
			},
			getblockheader: () => ({ height: 899_999 }),
			gettxout: () => null
		});

		const detail = await getTxDetail(node, 'child');
		expect(detail.fee).toBeNull();
		expect(detail.feeRate).toBeNull();
		// and no prevout resolution was even attempted -- only the tx's own getrawtransaction call fired
		const call = (node.coreRpc.call as unknown as { mock: { calls: unknown[][] } }).mock;
		const grtCalls = call.calls.filter((c) => c[0] === 'getrawtransaction');
		expect(grtCalls.length).toBe(1);
	});

	it('a coinbase tx has fee/feeRate null (not applicable, never fabricated 0) and pool null pre-M5', async () => {
		const node = mockNode({
			getrawtransaction: () =>
				confirmedTx({
					txid: 'coinbasetx',
					vin: [{ coinbase: 'abcd' }],
					vout: [{ address: 'bc1qminer', value: 3.125 }],
					blockhash: 'blockhash1',
					confirmations: 5
				}),
			getblockheader: () => ({ height: 899_995 }),
			gettxout: () => ({ value: 3.125 }) // still unspent -- the coinbase output itself
		});

		const detail = await getTxDetail(node, 'coinbasetx');
		expect(detail.fee).toBeNull();
		expect(detail.feeRate).toBeNull();
		expect(detail.vin[0].coinbase).toBe(true);
		expect(detail.pool).toBeNull(); // no mining_blocks table pre-M5
	});

	it('an unconfirmed tx: confirmations 0, richness basic block context, cpfp attempted', async () => {
		const node = mockNode({
			getrawtransaction: (params) => {
				const [txid] = params as [string];
				if (txid === 'unconf')
					return confirmedTx({
						txid: 'unconf',
						vin: [{ txid: 'parent', vout: 0 }],
						vout: [{ address: 'bc1qrecipient', value: 0.0009 }]
						// no blockhash -- unconfirmed
					});
				return parentTx('parent', 0.001);
			},
			getmempoolentry: () => {
				throw Object.assign(new Error('not in mempool'), { rpcCode: -5 });
			},
			gettxout: () => null
		});

		const detail = await getTxDetail(node, 'unconf');
		expect(detail.confirmed).toBe(false);
		expect(detail.confirmations).toBe(0);
		expect(detail.blockContext.confirmed).toBe(false);
		expect(detail.cpfp).toBeNull(); // getmempoolentry failed -- honestly null
	});

	it('caches only once confirmations >= 1 -- an unconfirmed tx is never cached', async () => {
		let grtCalls = 0;
		const node = mockNode({
			// A synthetic coinbase-shaped unconfirmed tx -- isolates the cache
			// assertion from prevout-resolution call counting (a coinbase never
			// triggers a parent-tx fetch).
			getrawtransaction: () => {
				grtCalls++;
				return confirmedTx({
					txid: 'unconf',
					vin: [{ coinbase: 'ab' }],
					vout: [{ address: 'bc1qrecipient', value: 0.0009 }]
				});
			},
			getmempoolentry: () => {
				throw Object.assign(new Error('not in mempool'), { rpcCode: -5 });
			},
			gettxout: () => null
		});

		await getTxDetail(node, 'unconf');
		await getTxDetail(node, 'unconf');
		expect(grtCalls).toBe(2); // one getrawtransaction call per getTxDetail call -- never cached
	});

	it('caches a confirmed tx -- a second call never re-hits the rail', async () => {
		let grtCalls = 0;
		const node = mockNode({
			getrawtransaction: (params) => {
				grtCalls++;
				const [txid] = params as [string];
				if (txid === 'child')
					return confirmedTx({
						txid: 'child',
						vin: [{ txid: 'parent', vout: 0 }],
						vout: [{ address: 'bc1qrecipient', value: 0.0009 }],
						blockhash: 'blockhash1',
						confirmations: 1
					});
				return parentTx('parent', 0.001);
			},
			getblockheader: () => ({ height: 899_999 }),
			gettxout: () => null
		});

		await getTxDetail(node, 'child');
		const callsAfterFirst = grtCalls;
		await getTxDetail(node, 'child');
		expect(grtCalls).toBe(callsAfterFirst); // second call served entirely from cache
	});
});

describe('chain/tx: getCpfpInfo', () => {
	function entry(vsize: number, feeBtc: number, ancestorcount = 1, descendantcount = 1) {
		return {
			vsize,
			weight: vsize * 4,
			time: 0,
			height: 0,
			descendantcount,
			descendantsize: 0,
			ancestorcount,
			ancestorsize: 0,
			wtxid: 'w',
			fees: { base: feeBtc, modified: feeBtc, ancestor: feeBtc, descendant: feeBtc },
			depends: [],
			spentby: [],
			'bip125-replaceable': false
		};
	}

	it('returns null (never throws) when the tx is not in the mempool', async () => {
		const node = mockNode({
			getmempoolentry: () => {
				throw Object.assign(new Error('not in mempool'), { rpcCode: -5 });
			}
		});
		await expect(getCpfpInfo(node, 'confirmed-or-unknown-tx')).resolves.toBeNull();
	});

	it('boostedByDescendant is true when a descendant meaningfully raises the effective rate', async () => {
		// own: 140 vsize, 0.00001400 BTC fee => 10 sat/vB.
		// descendant: 100 vsize, 0.00005000 BTC fee => 50 sat/vB -- well over threshold.
		const node = mockNode({
			getmempoolentry: () => entry(140, 0.000014, 1, 2),
			getmempoolancestors: () => ({}),
			getmempooldescendants: () => ({ d1: entry(100, 0.00005, 1, 1) })
		});
		const cpfp = await getCpfpInfo(node, 'txid');
		expect(cpfp?.boostedByDescendant).toBe(true);
		expect(cpfp?.bumpsAncestor).toBe(false);
		expect(cpfp?.descendantCount).toBe(1);
	});

	it('a difference just past the floor (0.1 sat/vB, ~1%) DOES flip boostedByDescendant', async () => {
		// own: 1400 sats / 140 vsize = 10 sat/vB exactly.
		// descendant: 1020 sats / 100 vsize = 10.2 sat/vB -- diff 0.2, safely
		// past the max(0.1, 10*0.01)=0.1 floor (kept off the exact float
		// boundary so the assertion isn't itself flaky on rounding).
		const node = mockNode({
			getmempoolentry: () => entry(140, 0.000014, 1, 2),
			getmempoolancestors: () => ({}),
			getmempooldescendants: () => ({ d1: entry(100, 0.0000102, 1, 1) })
		});
		const cpfp = await getCpfpInfo(node, 'txid');
		expect(cpfp?.ownFeeRate).toBeCloseTo(10, 5);
		expect(cpfp?.boostedByDescendant).toBe(true);
	});

	it('sub-threshold noise (< 0.1 sat/vB AND < 1%) never flips the badge', async () => {
		// own: 1400/140 = 10 sat/vB. descendant: 1005/100 = 10.05 sat/vB --
		// diff 0.05, under BOTH the 0.1 sat/vB floor and the 1% (0.1) floor.
		const node = mockNode({
			getmempoolentry: () => entry(140, 0.000014, 1, 2),
			getmempoolancestors: () => ({}),
			getmempooldescendants: () => ({ d1: entry(100, 0.00001005, 1, 1) })
		});
		const cpfp = await getCpfpInfo(node, 'txid');
		expect(cpfp?.boostedByDescendant).toBe(false);
	});

	it('bumpsAncestor is true when this tx pays notably more than its ancestor', async () => {
		const node = mockNode({
			getmempoolentry: () => entry(140, 0.00005, 2, 1), // ~35.7 sat/vB (own)
			getmempoolancestors: () => ({ a1: entry(140, 0.000005, 1, 1) }), // ~3.6 sat/vB
			getmempooldescendants: () => ({})
		});
		const cpfp = await getCpfpInfo(node, 'txid');
		expect(cpfp?.bumpsAncestor).toBe(true);
		expect(cpfp?.boostedByDescendant).toBe(false);
	});
});
