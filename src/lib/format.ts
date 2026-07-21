/**
 * Shared money-formatting helpers (DECISIONS.md §3's tabular-numerals rule).
 * One tested implementation so "does a zero balance render as a number or
 * blank" is answered once and can never quietly drift between the wallet
 * list, the wallet hero, and any future surface (Home's balance, the Owner
 * household roll-up, ...) via a copy-pasted local `fmtSats`.
 *
 * `(0).toLocaleString('en-US')` already returns `"0"`, never `""` -- but this
 * was reported as a live "zero balance renders blank" bug (hearth-lm1.15)
 * against duplicated per-component formatters, so the fix is to have exactly
 * ONE implementation, imported everywhere, locked down by format.spec.ts.
 */

/** Format a sat amount with thousands separators. Zero renders as "0", never "". */
export function formatSats(sats: number): string {
	return sats.toLocaleString('en-US');
}
