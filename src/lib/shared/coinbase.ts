/**
 * Coinbase (mining reward) output maturity math (MINING-ENGINE.md §6.1, §8).
 * Bitcoin consensus requires a coinbase output to reach 100 confirmations
 * before it can be spent -- this protects against loss if the mining block is
 * later reorganized out of the chain. Pure and shared between server (mining
 * read models) and client (the mining dashboard's blocks-found list).
 *
 * Ported as a pattern from cairn's src/lib/shared/coinbase.ts.
 *
 * Note: `src/lib/server/wallet/select.ts` already defines its own server-side
 * `COINBASE_MATURITY = 100` for PSBT coin-selection maturity checks. This is a
 * deliberate, intentional duplication rather than an import -- this module
 * lives under `$lib/shared` so the mining dashboard's client-side code can use
 * it directly, and `wallet/select.ts` is a server-only module. Both encode the
 * same consensus constant; keeping them in sync is a code-review discipline,
 * not a runtime coupling.
 */

/** Confirmations a coinbase output needs before it can be spent (consensus rule). */
export const COINBASE_MATURITY = 100;

/** Rough minutes per block, for the "time until spendable" estimate. */
const BLOCK_MINUTES = 10;

export interface CoinbaseMaturity {
	/** Confirmations so far: tip - height + 1, clamped to 0 (0 = unconfirmed). */
	confirmations: number;
	/** Confirmations required to spend (COINBASE_MATURITY). */
	required: number;
	/** True once the output can be spent. */
	mature: boolean;
	/** Blocks still needed before it matures (0 when mature). */
	blocksRemaining: number;
	/** Rough hours until mature, rounded up (0 when mature). */
	etaHours: number;
}

/**
 * Maturity of a coinbase output confirmed at block `height`, given the
 * current chain `tipHeight`. An unconfirmed output (height <= 0) reports 0
 * confirmations.
 */
export function coinbaseMaturity(height: number, tipHeight: number): CoinbaseMaturity {
	const confirmations = height > 0 && tipHeight >= height ? tipHeight - height + 1 : 0;
	const blocksRemaining = Math.max(0, COINBASE_MATURITY - confirmations);
	return {
		confirmations,
		required: COINBASE_MATURITY,
		mature: confirmations >= COINBASE_MATURITY,
		blocksRemaining,
		etaHours: Math.ceil((blocksRemaining * BLOCK_MINUTES) / 60)
	};
}

/** True when a coinbase output at `height` is NOT yet spendable at `tipHeight`. */
export function isImmatureCoinbase(height: number, tipHeight: number): boolean {
	return !coinbaseMaturity(height, tipHeight).mature;
}
