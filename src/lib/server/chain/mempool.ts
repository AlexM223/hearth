/**
 * Mempool summary + fee histogram (EXPLORER.md §1.3): Core `getmempoolinfo`
 * for the count/bytes/fees summary (no Electrum equivalent); Electrum
 * `mempool.get_fee_histogram` for the histogram (no Core equivalent). Two
 * genuinely independent single-rail datums -- neither has a fallback, so
 * richness is a plain full/none per §1.3's table.
 */
import { getMempoolInfo, type RpcCaller } from '../node/core/rpc.js';
import { mempoolSummaryCache, feeHistogramCache, GLOBAL_KEY } from './cache.js';
import type { FeeHistogramBucket, MempoolSummary, Richness } from './types.js';

export interface MempoolCoreRail {
	coreRpc: RpcCaller;
}

export interface MempoolElectrumRail {
	electrum: {
		getFeeHistogram(): Promise<[number, number][]>;
	};
}

export async function getMempoolSummary(node: MempoolCoreRail): Promise<MempoolSummary> {
	const cached = mempoolSummaryCache.get(GLOBAL_KEY);
	if (cached) return cached;
	try {
		const info = await getMempoolInfo(node.coreRpc);
		const summary: MempoolSummary = {
			txCount: info.size,
			bytes: info.bytes,
			totalFeeSats: Math.round(info.total_fee * 1e8),
			richness: 'full'
		};
		mempoolSummaryCache.set(GLOBAL_KEY, summary);
		return summary;
	} catch {
		return { txCount: null, bytes: null, totalFeeSats: null, richness: 'none' as Richness };
	}
}

export interface FeeHistogramResult {
	buckets: FeeHistogramBucket[]; // highest feeRate first (Electrum's own order)
	richness: Richness;
}

export async function getFeeHistogram(node: MempoolElectrumRail): Promise<FeeHistogramResult> {
	const cached = feeHistogramCache.get(GLOBAL_KEY);
	if (cached) return { buckets: cached.map(([feeRate, vsize]) => ({ feeRate, vsize })), richness: 'full' };
	try {
		const raw = await node.electrum.getFeeHistogram();
		feeHistogramCache.set(GLOBAL_KEY, raw);
		return { buckets: raw.map(([feeRate, vsize]) => ({ feeRate, vsize })), richness: 'full' };
	} catch {
		return { buckets: [], richness: 'none' };
	}
}
