/**
 * In-process Stratum V1 engine (DECISIONS.md §4.6), off by default (feature
 * flag + operator setting + Core RPC all required). Ports 3333 (standard) /
 * 3334 (ASIC-floor); SV2 gets a NEW port 3335 later (M8), never repurposing
 * 3334. Non-custodial hard gate: exactly one value-bearing output in every
 * coinbase, asserted in code.
 *
 * This is the module's PUBLIC SURFACE (MINING-ENGINE.md §1.2) -- routes, the
 * SSE bridge, and the explorer import from here only, never reaching into a
 * sibling file directly.
 *
 * T0 note: this file starts as a lifecycle-bridge STUB (just enough surface
 * for prefs.ts's onPrefsChanged hook to compile/link against) and is filled
 * in fully at T6 once wire/coinbase/job/stratum/authTable/miningPool/
 * aggregates all exist. Later T-steps extend it in place; nothing exported
 * here is expected to change shape once T6 lands.
 */

export const MINING_ENABLED_DEFAULT = false;
export const STRATUM_PORT_STANDARD = 3333;
export const STRATUM_PORT_ASIC_FLOOR = 3334;

/**
 * Prefs-change hook (prefs.ts calls this after every mutation). Rebuilds the
 * auth snapshot off the hot path once the engine actually exists (T6) --
 * until then this is an intentional no-op so T0's prefs.ts/settings.ts can
 * ship and be tested standalone.
 */
export function onPrefsChanged(): void {
	// Filled in at T6 (refreshAuthTable() when the engine is running).
}
