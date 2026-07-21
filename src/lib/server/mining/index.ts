/**
 * In-process Stratum V1 engine (DECISIONS.md §4.6), off by default (feature
 * flag + operator setting + Core RPC all required). Ports 3333 (standard) /
 * 3334 (ASIC-floor); SV2 gets a NEW port 3335 later (M8), never repurposing
 * 3334. Non-custodial hard gate: exactly one value-bearing output in every
 * coinbase, asserted in code. Stub for M0, built in M5.
 */
export const MINING_ENABLED_DEFAULT = false;
export const STRATUM_PORT_STANDARD = 3333;
export const STRATUM_PORT_ASIC_FLOOR = 3334;
