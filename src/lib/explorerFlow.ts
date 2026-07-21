/**
 * Pure client-safe helpers for the Explorer's mempool->block flow visual
 * (EXPLORER.md §3.2) -- no server import, so this can be used directly from
 * `+page.svelte`. Bucketing the fee histogram into the 5 --fee-1..5 bands
 * and the "one square per ~25,000 vB, capped at 40" square-count math live
 * here, unit-tested, rather than inlined into template markup.
 */

export interface FeeHistogramBucket {
	feeRate: number;
	vsize: number;
}

export interface FeeBand {
	/** 1 (economy, coolest) .. 5 (priority, warmest) -- matches --fee-N. */
	tier: 1 | 2 | 3 | 4 | 5;
	label: string;
	totalVsize: number;
	/** Squares to render, bottom-up, capped at MAX_SQUARES_PER_LANE. */
	squares: number;
	/** vsize represented above the cap -- render as a "+N,NNN vB more" label. */
	overflowVsize: number;
}

export const SQUARE_VSIZE = 25_000;
export const MAX_SQUARES_PER_LANE = 40;

const BAND_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
	1: 'economy',
	2: 'low',
	3: 'mid',
	4: 'high',
	5: 'priority'
};

/** economy(1) .. priority(5), a fixed sat/vB partition of a typical mempool. */
function tierFor(feeRate: number): 1 | 2 | 3 | 4 | 5 {
	if (feeRate >= 50) return 5;
	if (feeRate >= 20) return 4;
	if (feeRate >= 10) return 3;
	if (feeRate >= 5) return 2;
	return 1;
}

/** Buckets a fee histogram (highest feeRate first, Electrum's own order)
 *  into the 5 fixed fee bands, returned economy-first (tier 1..5) so the
 *  caller can lay lanes out left(economy)->right(priority)-adjacent-to-
 *  divider per §3.2. */
export function bucketFeeHistogram(buckets: FeeHistogramBucket[]): FeeBand[] {
	const totals: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const b of buckets) {
		totals[tierFor(b.feeRate)] += b.vsize;
	}
	return ([1, 2, 3, 4, 5] as const).map((tier) => {
		const total = totals[tier];
		const rawSquares = Math.ceil(total / SQUARE_VSIZE);
		const squares = Math.min(MAX_SQUARES_PER_LANE, rawSquares);
		const overflowVsize = rawSquares > MAX_SQUARES_PER_LANE ? total - MAX_SQUARES_PER_LANE * SQUARE_VSIZE : 0;
		return { tier, label: BAND_LABELS[tier], totalVsize: total, squares, overflowVsize };
	});
}
