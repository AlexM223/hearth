/**
 * getFeeRecommendation (EXPLORER.md §1.3/§3.1): the ONE glanceable sat/vB
 * number + a plain-English caption + the fastest/~30min/~1hr/economy tiered
 * ladder. THE single implementation -- also called in-process by the
 * wallet module's send-screen fee picker whenever that UI is built
 * (DECISIONS.md §0 rule 3's spirit applied outside the money path too, not
 * a duplicated copy). Electrum `estimatefee(target)` primary per tier;
 * Core `estimatesmartfee(target, mode)` fills any tier Electrum can't
 * price (-1/no estimate). The whole ladder is floored at Core's own
 * `mempoolminfee` (which is itself already `max(minrelaytxfee, dynamic
 * mempool floor)` in Core's own semantics) and forced monotonic so mixing
 * two estimators never inverts fastest < economy.
 */
import { estimateSmartFee, getMempoolInfo, type RpcCaller } from '../node/core/rpc.js';
import { feeRecommendationCache, GLOBAL_KEY } from './cache.js';
import type { FeeRecommendation, Richness } from './types.js';

export interface FeesElectrumRail {
	estimateFee(targetBlocks: number): Promise<number>; // BTC/kvB, or -1 when no estimate
}

export interface FeesNode {
	electrum: FeesElectrumRail;
	coreRpc: RpcCaller;
}

interface TierSpec {
	label: string;
	target: number;
}

const TIERS: TierSpec[] = [
	{ label: 'fastest', target: 1 },
	{ label: '~30 min', target: 3 },
	{ label: '~1 hr', target: 6 },
	{ label: 'economy', target: 25 }
];

function btcPerKvbToSatPerVb(btcPerKvb: number): number {
	return (btcPerKvb * 1e8) / 1000;
}

async function estimateTier(node: FeesNode, target: number): Promise<number | null> {
	try {
		const btcPerKvb = await node.electrum.estimateFee(target);
		if (typeof btcPerKvb === 'number' && btcPerKvb > 0) return btcPerKvbToSatPerVb(btcPerKvb);
	} catch {
		// fall through to Core
	}
	try {
		const est = await estimateSmartFee(node.coreRpc, target);
		if (typeof est.feerate === 'number' && est.feerate > 0) return btcPerKvbToSatPerVb(est.feerate);
	} catch {
		// no estimate from either rail for this tier
	}
	return null;
}

/** Two linear passes: carry the nearest known REAL estimate forward, then
 *  backward -- every tier ends up a genuinely-sourced number (from some
 *  tier), never an invented constant. Only reached once at least one tier
 *  resolved (the caller checks this first). */
function fillGaps(vals: (number | null)[]): number[] {
	const out = [...vals];
	for (let i = 1; i < out.length; i++) if (out[i] === null) out[i] = out[i - 1];
	for (let i = out.length - 2; i >= 0; i--) if (out[i] === null) out[i] = out[i + 1];
	return out as number[];
}

/** fastest (index 0) must be >= every slower tier -- clamp any inversion
 *  caused by mixing two independent estimators (nodeview's fix). */
function enforceMonotonic(vals: number[]): number[] {
	const out = [...vals];
	for (let i = 1; i < out.length; i++) out[i] = Math.min(out[i], out[i - 1]);
	return out.map((v) => Math.max(1, Math.round(v)));
}

export async function getFeeRecommendation(node: FeesNode): Promise<FeeRecommendation> {
	const cached = feeRecommendationCache.get(GLOBAL_KEY);
	if (cached) return cached;

	const raw = await Promise.all(TIERS.map((t) => estimateTier(node, t.target)));

	let floor = 1;
	try {
		const info = await getMempoolInfo(node.coreRpc);
		floor = Math.max(1, btcPerKvbToSatPerVb(info.mempoolminfee));
	} catch {
		// no Core floor available -- Electrum-only estimates stand as-is
	}

	if (raw.every((v) => v === null)) {
		// Neither rail priced ANY tier -- there is no honest non-fabricated
		// number to hand back (satPerVb is non-nullable). The caller (route
		// layer) catches this and renders the page's own richness:'none' state.
		throw new Error('fee recommendation unavailable -- both Electrum and Core rails are down');
	}

	const floored = raw.map((v) => (v === null ? null : Math.max(floor, v)));
	const filled = fillGaps(floored);
	const monotonic = enforceMonotonic(filled);

	const richness: Richness = raw.every((v) => v !== null) ? 'full' : 'basic';

	const rec: FeeRecommendation = {
		satPerVb: monotonic[0],
		caption: 'Confirms in the next block · about 10 minutes',
		tiers: TIERS.map((t, i) => ({ label: t.label, satPerVb: monotonic[i] })),
		richness
	};
	feeRecommendationCache.set(GLOBAL_KEY, rec);
	return rec;
}
