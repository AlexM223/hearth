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

/**
 * Approximate wall-clock age of a confirmation from its block depth alone
 * (~10 minutes per block). "block 731,097" means nothing without a date, and
 * the wallet-history read model deliberately stores only heights -- the "~"
 * keeps the label honest about being an estimate, not a header timestamp.
 * depth <= 0 (unconfirmed / at-tip / unknown tip) returns "".
 */
export function approxAgeFromDepth(depth: number): string {
	if (depth <= 0) return '';
	const minutes = depth * 10;
	if (minutes < 60) return `~${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `~${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 60) return `~${days} d ago`;
	const months = Math.round(days / 30);
	if (months < 24) return `~${months} mo ago`;
	return `~${Math.round(days / 365)} y ago`;
}
