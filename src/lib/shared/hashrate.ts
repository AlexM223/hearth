/**
 * Hashrate formatting + solo-odds math (MINING-ENGINE.md §5, §6.3). Pure and
 * shared between the server (mining aggregates / read models) and the client
 * (mining dashboard) -- no I/O, no Node built-ins -- so both sides render
 * identical numbers.
 *
 * Ported as a pattern from cairn's src/lib/shared/hashrate.ts.
 *
 * Past bug this guards against (inherited note): a formatter written only for
 * network-scale hashrate (EH/s) rendered a Bitaxe-class miner (hundreds of
 * GH/s to a few TH/s) as "0.0 PH/s". The ladder below descends all the way to
 * H/s so a small USB/Bitaxe miner reads honestly in GH/s or TH/s, and a
 * pool/network figure reads in PH/s or EH/s -- one function, both scales.
 */

/** Ascending unit ladder: [threshold in H/s, suffix]. */
const UNITS: readonly [number, string][] = [
	[1, 'H/s'],
	[1e3, 'kH/s'],
	[1e6, 'MH/s'],
	[1e9, 'GH/s'],
	[1e12, 'TH/s'],
	[1e15, 'PH/s'],
	[1e18, 'EH/s']
];

/**
 * Format a hashrate in hashes/second onto the H/s->EH/s ladder. Picks the
 * largest unit at which the value is >= 1 (so 1.2e12 -> "1.2 TH/s", 5e17 ->
 * "0.5 EH/s"), capping at EH/s for astronomically large inputs. One decimal
 * below 100 in the chosen unit, none at or above it ("12.3 GH/s" but
 * "480 GH/s"). Null, non-finite, or <= 0 renders as an em-dash -- the app's
 * "unknown" glyph, never a misleading "0.0 H/s".
 */
export function formatHashrate(hps: number | null | undefined): string {
	if (hps == null || !Number.isFinite(hps) || hps <= 0) return '—';
	let chosen = UNITS[0]!;
	for (const unit of UNITS) {
		if (hps >= unit[0]) chosen = unit;
	}
	const value = hps / chosen[0];
	const decimals = value < 100 ? 1 : 0;
	return `${value.toFixed(decimals)} ${chosen[1]}`;
}

/**
 * Estimate hashrate (hashes/second) from the difficulty-weighted shares seen
 * in a window. Each accepted share of difficulty d represents, in
 * expectation, d*2^32 hashes computed; summed over the window and divided by
 * its length is the average hashrate. Returns 0 for an empty or non-positive
 * window (no basis to estimate -- never Infinity/NaN).
 */
export function estimateHashrate(sumDifficulty: number, windowSec: number): number {
	if (!Number.isFinite(sumDifficulty) || sumDifficulty <= 0) return 0;
	if (!Number.isFinite(windowSec) || windowSec <= 0) return 0;
	return (sumDifficulty * 2 ** 32) / windowSec;
}

/** Blocks the Bitcoin network produces in a year / a day, at the 10-min target. */
const BLOCKS_PER_YEAR = 52560; // 6 * 24 * 365
const BLOCKS_PER_DAY = 144; // 6 * 24

export interface SoloOdds {
	/** Expected years between blocks for this miner at the current network rate. */
	expectedYearsPerBlock: number;
	/** Probability (percent) of finding at least one block in the next 24h. */
	probPerDayPct: number;
}

/**
 * Solo-mining odds for a miner contributing `userHps` against a `networkHps`
 * total (MINING-ENGINE.md §6.3 -- NEVER an earnings/BTC projection).
 * `fraction` is the miner's share of global hashrate; over N blocks the
 * chance of finding none is (1 - fraction)^N ~= e^(-fraction*N), so the daily
 * hit probability is 1 - e^(-fraction*144). Expected years/block is the
 * reciprocal of the blocks-per-year the fraction earns. Null when either
 * input is missing/non-positive (no honest estimate without both rates).
 */
export function soloOdds(userHps: number, networkHps: number): SoloOdds | null {
	if (!Number.isFinite(userHps) || userHps <= 0) return null;
	if (!Number.isFinite(networkHps) || networkHps <= 0) return null;
	const fraction = userHps / networkHps;
	if (!Number.isFinite(fraction) || fraction <= 0) return null;
	return {
		expectedYearsPerBlock: 1 / (fraction * BLOCKS_PER_YEAR),
		probPerDayPct: (1 - Math.exp(-fraction * BLOCKS_PER_DAY)) * 100
	};
}
