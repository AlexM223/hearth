import { describe, expect, it } from 'vitest';
import { bucketFeeHistogram, MAX_SQUARES_PER_LANE, SQUARE_VSIZE } from './explorerFlow.js';

describe('lib/explorerFlow: bucketFeeHistogram', () => {
	it('assigns each bucket to its fee band by sat/vB', () => {
		const bands = bucketFeeHistogram([
			{ feeRate: 60, vsize: 10_000 }, // priority (5)
			{ feeRate: 25, vsize: 10_000 }, // high (4)
			{ feeRate: 12, vsize: 10_000 }, // mid (3)
			{ feeRate: 6, vsize: 10_000 }, // low (2)
			{ feeRate: 1, vsize: 10_000 } // economy (1)
		]);
		expect(bands.map((b) => b.totalVsize)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
		expect(bands.map((b) => b.tier)).toEqual([1, 2, 3, 4, 5]);
	});

	it('sums multiple buckets into the same band', () => {
		const bands = bucketFeeHistogram([
			{ feeRate: 55, vsize: 5000 },
			{ feeRate: 70, vsize: 5000 }
		]);
		expect(bands.find((b) => b.tier === 5)?.totalVsize).toBe(10_000);
	});

	it('one square per ~25,000 vB, rounding up', () => {
		const bands = bucketFeeHistogram([{ feeRate: 1, vsize: SQUARE_VSIZE + 1 }]);
		expect(bands.find((b) => b.tier === 1)?.squares).toBe(2);
	});

	it('caps squares at MAX_SQUARES_PER_LANE and reports the overflow vsize', () => {
		const massiveVsize = SQUARE_VSIZE * (MAX_SQUARES_PER_LANE + 10);
		const bands = bucketFeeHistogram([{ feeRate: 1, vsize: massiveVsize }]);
		const economy = bands.find((b) => b.tier === 1)!;
		expect(economy.squares).toBe(MAX_SQUARES_PER_LANE);
		expect(economy.overflowVsize).toBe(massiveVsize - MAX_SQUARES_PER_LANE * SQUARE_VSIZE);
	});

	it('an empty histogram yields all-zero bands, never a crash', () => {
		const bands = bucketFeeHistogram([]);
		expect(bands).toHaveLength(5);
		for (const b of bands) {
			expect(b.totalVsize).toBe(0);
			expect(b.squares).toBe(0);
			expect(b.overflowVsize).toBe(0);
		}
	});
});
