/**
 * Client-safe send-amount sanity checks (UX sweep hearth-5vw). A fail-fast UI
 * gate only, mirrored against the server's authoritative range/dust rules
 * (`$lib/server/wallet/select.ts`'s `dustThreshold`/`MAX_FEE_RATE`-adjacent
 * checks) without importing that server-only module from a `.svelte`
 * component. `MIN_SEND_SATS` is deliberately the HIGHEST of the four
 * per-output-kind dust thresholds (P2PKH's 546) -- a conservative "this is
 * definitely too small" floor; the server still enforces the exact
 * kind-specific threshold once the destination script type is known.
 */

export const MIN_SEND_SATS = 546;
/** 21,000,000 BTC in sats -- never a real amount; guards fat-finger overflow. */
export const MAX_SEND_SATS = 21_000_000 * 100_000_000;

/** True iff `raw` (the Amount field's string value) is a sane whole-sat send
 *  amount: a positive integer within [MIN_SEND_SATS, MAX_SEND_SATS]. */
export function isValidSendAmount(raw: string): boolean {
	if (raw.trim() === '') return false;
	const n = Number(raw);
	return Number.isFinite(n) && Number.isInteger(n) && n >= MIN_SEND_SATS && n <= MAX_SEND_SATS;
}
