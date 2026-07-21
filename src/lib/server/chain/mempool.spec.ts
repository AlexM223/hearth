import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCaches } from './cache.js';
import { getMempoolSummary, getFeeHistogram } from './mempool.js';
import type { RpcCaller } from '../node/core/rpc.js';

beforeEach(() => {
	clearAllCaches();
});

describe('chain/mempool: getMempoolSummary', () => {
	it('richness full when Core answers', async () => {
		const call = vi.fn(async () => ({ size: 12000, bytes: 5_000_000, total_fee: 0.5 }));
		const summary = await getMempoolSummary({ coreRpc: { call: call as RpcCaller['call'] } });
		expect(summary).toEqual({ txCount: 12000, bytes: 5_000_000, totalFeeSats: 50_000_000, richness: 'full' });
	});

	it('richness none (all null, never a fabricated 0) when Core is down', async () => {
		const call = vi.fn(async () => {
			throw new Error('core down');
		});
		const summary = await getMempoolSummary({ coreRpc: { call: call as RpcCaller['call'] } });
		expect(summary).toEqual({ txCount: null, bytes: null, totalFeeSats: null, richness: 'none' });
	});
});

describe('chain/mempool: getFeeHistogram', () => {
	it('preserves Electrum highest-fee-first bucket order', async () => {
		const node = { electrum: { getFeeHistogram: vi.fn(async () => [[50, 1000], [10, 5000]] as [number, number][]) } };
		const result = await getFeeHistogram(node);
		expect(result.richness).toBe('full');
		expect(result.buckets).toEqual([
			{ feeRate: 50, vsize: 1000 },
			{ feeRate: 10, vsize: 5000 }
		]);
	});

	it('richness none, empty buckets when Electrum is down -- no Core equivalent', async () => {
		const node = {
			electrum: {
				getFeeHistogram: vi.fn(async () => {
					throw new Error('electrum down');
				})
			}
		};
		const result = await getFeeHistogram(node);
		expect(result).toEqual({ buckets: [], richness: 'none' });
	});
});
