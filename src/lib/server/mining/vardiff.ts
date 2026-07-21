/**
 * Variable-difficulty math for the Stratum V1 server (`stratum.ts`) --
 * MINING-ENGINE.md §4. Pure -- no sockets, no timers, no message framing --
 * so the retarget decision itself has a direct, isolated unit test separate
 * from the announce-time freeze/rate-window bookkeeping (job-specific,
 * inherently stateful across (connection, jobId) pairs) that stays inline in
 * `stratum.ts`.
 *
 * Ported as a pattern from cairn's `mining/sv2/vardiff.ts` (a "deliberate
 * duplicate" there, kept separate from cairn's V1 `stratum.ts` so the two
 * listeners' retarget math could drift independently by explicit choice).
 * Hearth builds no SV2 listener in M5, so there is only one Stratum server --
 * this module IS its vardiff math, imported directly by `stratum.ts` rather
 * than being re-duplicated inline.
 *
 *   - rate-based: compare the accepted-share rate over the observation window
 *     against `targetSharesPerMin`, x2 when too fast, /2 when too slow, no-op
 *     inside the tolerance band.
 *   - power-of-two snap (`nearestPowerOfTwo`) so announced difficulties stay
 *     human-legible.
 *   - clamp to `[floorDifficulty, maxDifficulty]` -- the floor is always the
 *     listener's own `shareDifficulty` (never negotiable down), the ceiling
 *     is an overflow-DoS guard (the 2^48 hard cap, MINING-ENGINE.md §4).
 *   - a no-op adjustment (snapped value equals the current difficulty) never
 *     fires a wire message.
 */

export interface VardiffOptions {
	/** Per-connection target rate of ACCEPTED shares, in shares per minute. */
	readonly targetSharesPerMin: number;
	/** Minimum interval between difficulty adjustments. Default 15_000 ms. */
	readonly adjustIntervalMs?: number;
	/** Rolling accepted-share window for rate measurement. Default 60_000 ms. */
	readonly windowMs?: number;
	/** Clock source (test hook for deterministic specs). Default Date.now. */
	readonly now?: () => number;
	/** Hard ceiling on difficulty (overflow-DoS guard). Default 2^48. */
	readonly maxDifficulty?: number;
}

export interface NormalizedVardiff {
	readonly targetSharesPerMin: number;
	readonly adjustIntervalMs: number;
	readonly windowMs: number;
	readonly now: () => number;
	readonly maxDifficulty: number;
}

const DEFAULT_VARDIFF_ADJUST_INTERVAL_MS = 15_000;
const DEFAULT_VARDIFF_WINDOW_MS = 60_000;
/** Retarget only once the measured rate is outside ±30% of the target rate. */
export const VARDIFF_RATE_TOLERANCE = 0.3;
/**
 * Default hard ceiling on vardiff-adjusted difficulty (float64-overflow
 * guard, MINING-ENGINE.md §4): without it, a connection sustaining an
 * above-target rate doubles every cycle with no bound, eventually
 * overflowing float64 to Infinity, at which point `nearestPowerOfTwo` throws
 * synchronously inside the socket data-handler chain and crashes the whole
 * process. 2^48 is exact under the snap and well within MAX_SAFE_INTEGER
 * (2^53).
 */
export const MAX_VARDIFF_DEFAULT = 2 ** 48;

/**
 * Validate + apply defaults to a caller-supplied {@link VardiffOptions}.
 * `undefined` (vardiff disabled) passes through as `null`. Throws the same
 * messages stratum.ts's constructor has always thrown (its tests assert
 * against these substrings) -- never re-wrap or reword them.
 */
export function normalizeVardiffOptions(
	v: VardiffOptions | undefined,
	floorDifficulty: number
): NormalizedVardiff | null {
	if (v === undefined) return null;
	if (!Number.isFinite(v.targetSharesPerMin) || v.targetSharesPerMin <= 0) {
		throw new Error(`vardiff.targetSharesPerMin must be a positive number, got ${v.targetSharesPerMin}`);
	}
	const adjustIntervalMs = v.adjustIntervalMs ?? DEFAULT_VARDIFF_ADJUST_INTERVAL_MS;
	const windowMs = v.windowMs ?? DEFAULT_VARDIFF_WINDOW_MS;
	if (!Number.isInteger(adjustIntervalMs) || adjustIntervalMs <= 0) {
		throw new Error(`vardiff.adjustIntervalMs must be a positive integer, got ${adjustIntervalMs}`);
	}
	if (!Number.isInteger(windowMs) || windowMs <= 0) {
		throw new Error(`vardiff.windowMs must be a positive integer, got ${windowMs}`);
	}
	const maxDifficulty = v.maxDifficulty ?? MAX_VARDIFF_DEFAULT;
	if (!Number.isFinite(maxDifficulty) || maxDifficulty <= 0) {
		throw new Error(`vardiff.maxDifficulty must be a positive number, got ${maxDifficulty}`);
	}
	if (maxDifficulty < floorDifficulty) {
		throw new Error(`vardiff.maxDifficulty (${maxDifficulty}) must be >= shareDifficulty (${floorDifficulty})`);
	}
	return {
		targetSharesPerMin: v.targetSharesPerMin,
		adjustIntervalMs,
		windowMs,
		now: v.now ?? Date.now,
		maxDifficulty
	};
}

/** Snap a difficulty to the nearest power of two. */
export function nearestPowerOfTwo(d: number): number {
	if (!Number.isFinite(d) || d <= 0) throw new Error(`cannot snap difficulty ${d}`);
	return 2 ** Math.round(Math.log2(d));
}

export interface RetargetInput {
	/** Accepted-share count inside the (already-pruned) observation window. */
	readonly shareCount: number;
	/** Milliseconds actually observed since the last adjustment (capped to windowMs by the caller). */
	readonly observeMs: number;
	readonly currentDifficulty: number;
	readonly targetSharesPerMin: number;
	readonly maxDifficulty: number;
	readonly floorDifficulty: number;
}

/**
 * Decide the next difficulty for one connection, or `null` when no
 * adjustment should fire (inside tolerance, or the clamped/snapped result is
 * unchanged from the current difficulty -- a genuine no-op the caller must
 * not announce). Ceiling clamp is applied BEFORE the power-of-two snap (so a
 * runaway/Infinity value never reaches `nearestPowerOfTwo`), floor clamp
 * AFTER the snap (so the floor itself never gets rounded away from).
 */
export function decideRetarget(input: RetargetInput): number | null {
	const ratePerMin = (input.shareCount * 60_000) / input.observeMs;
	let next: number;
	if (ratePerMin > input.targetSharesPerMin * (1 + VARDIFF_RATE_TOLERANCE)) {
		next = input.currentDifficulty * 2;
	} else if (ratePerMin < input.targetSharesPerMin * (1 - VARDIFF_RATE_TOLERANCE)) {
		next = input.currentDifficulty / 2;
	} else {
		return null;
	}
	next = Math.min(next, input.maxDifficulty);
	next = nearestPowerOfTwo(next);
	if (next < input.floorDifficulty) next = input.floorDifficulty;
	if (next === input.currentDifficulty) return null;
	return next;
}
