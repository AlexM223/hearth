/**
 * Fee ladder tests (EXPLORER.md §6/§7 T5): monotonicity when mixing
 * Electrum/Core estimators, the mempoolminfee floor, gap-filling, and the
 * "one implementation" regression lock -- getFeeRecommendation is the ONLY
 * fee-recommendation-shaped function in the tree; the wallet module's own
 * send-screen fee picker (whenever built) is meant to import THIS function
 * rather than growing a second copy (DECISIONS.md §0 rule 3's spirit).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCaches } from './cache.js';
import { getFeeRecommendation, type FeesNode } from './fees.js';
import { getFeeRecommendation as getFeeRecommendationFromIndex } from './index.js';
import type { RpcCaller } from '../node/core/rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function mockNode(opts: {
	estimateFee?: (target: number) => Promise<number>;
	call?: (method: string, params?: unknown[]) => Promise<unknown>;
}): FeesNode {
	return {
		electrum: {
			estimateFee:
				opts.estimateFee ??
				vi.fn(async () => -1) // no estimate, by default
		},
		coreRpc: {
			call: (opts.call ??
				vi.fn(async () => {
					throw new Error('no core handler');
				})) as RpcCaller['call']
		}
	};
}

beforeEach(() => {
	clearAllCaches();
});

describe('chain/fees: getFeeRecommendation', () => {
	it('all four tiers priced by Electrum: richness full, monotonic ladder, sane caption', async () => {
		const rates: Record<number, number> = { 1: 0.00002, 3: 0.00001, 6: 0.000005, 25: 0.000001 }; // BTC/kvB
		const node = mockNode({ estimateFee: async (t) => rates[t] });
		const rec = await getFeeRecommendation(node);
		expect(rec.richness).toBe('full');
		expect(rec.satPerVb).toBe(2); // 0.00002 BTC/kvB = 2 sat/vB
		expect(rec.tiers.map((t) => t.satPerVb)).toEqual([2, 1, 1, 1]); // 0.5 and 0.1 sat/vB both floor to 1
		expect(rec.caption).toMatch(/next block/i);
	});

	it('mixing Electrum (fastest) + Core (a slower tier priced HIGHER) never inverts the ladder', async () => {
		// Electrum prices fastest at 5 sat/vB; Electrum has no estimate for the
		// slower "~1hr" tier (-1), so Core's estimatesmartfee fills it -- but
		// Core's independent estimator returns something inconsistent (8 sat/vB,
		// HIGHER than the fastest tier). Monotonic enforcement must clamp it.
		const node = mockNode({
			// BTC/kvB = satPerVb / 100_000. fastest=5 sat/vB, ~30min=3 sat/vB;
			// ~1hr/economy have no Electrum estimate (-1).
			estimateFee: async (t) => (t === 1 ? 5 / 100_000 : t === 3 ? 3 / 100_000 : -1),
			call: async (method: string, params: unknown[] = []) => {
				if (method === 'estimatesmartfee') {
					const [target] = params as [number];
					if (target === 6) return { feerate: 8 / 100_000, blocks: 6 }; // 8 sat/vB -- inconsistent
					return { errors: ['insufficient data'], blocks: 0 };
				}
				throw new Error('unexpected method');
			}
		});
		const rec = await getFeeRecommendation(node);
		// fastest=5, ~30min=3, ~1hr priced at 8 by Core but MUST clamp to <=3
		// (the running max from the previous, faster tier), economy fills forward.
		const [fastest, halfHour, hour, economy] = rec.tiers.map((t) => t.satPerVb);
		expect(fastest).toBe(5);
		expect(halfHour).toBe(3);
		expect(hour).toBeLessThanOrEqual(halfHour);
		expect(economy).toBeLessThanOrEqual(hour);
	});

	it('floors the whole ladder at Core mempoolminfee when Core answers', async () => {
		const node = mockNode({
			estimateFee: async () => 0.0000001, // 0.01 sat/vB -- below any realistic floor
			call: async (method: string) => {
				if (method === 'getmempoolinfo')
					return { loaded: true, size: 1, bytes: 1, usage: 1, total_fee: 0, maxmempool: 1, mempoolminfee: 0.00001 }; // 1 sat/vB floor
				throw new Error('unexpected');
			}
		});
		const rec = await getFeeRecommendation(node);
		for (const tier of rec.tiers) expect(tier.satPerVb).toBeGreaterThanOrEqual(1);
	});

	it('throws when NEITHER rail prices ANY tier (no honest number to fabricate)', async () => {
		const node = mockNode({ estimateFee: async () => -1 });
		await expect(getFeeRecommendation(node)).rejects.toThrow();
	});

	it('richness basic when some tiers are gap-filled from a neighbor', async () => {
		const node = mockNode({
			estimateFee: async (t) => (t === 1 ? 0.00001 : -1) // only the fastest tier priced
		});
		const rec = await getFeeRecommendation(node);
		expect(rec.richness).toBe('basic');
		// every tier still carries a real (borrowed) number, never a fabricated one
		for (const tier of rec.tiers) expect(tier.satPerVb).toBeGreaterThan(0);
	});
});

describe('chain/fees: one-implementation regression lock', () => {
	it('chain/index.ts re-exports the SAME getFeeRecommendation function (no duplicate)', () => {
		expect(getFeeRecommendationFromIndex).toBe(getFeeRecommendation);
	});

	it('no file under src/lib/server/wallet/ defines its own fee-recommendation-shaped function', () => {
		const walletDir = join(HERE, '..', 'wallet');
		const files = readdirSync(walletDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
		for (const file of files) {
			const source = readFileSync(join(walletDir, file), 'utf8');
			expect(source, `${file} must not define its own fee-recommendation function`).not.toMatch(
				/function\s+getFeeRecommendation\b/
			);
		}
	});
});
