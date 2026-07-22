/**
 * The deny-by-default API policy table (COME-ABOARD.md §3.3, §6.2). Layer 1
 * of the two-layer gate: `hooks.server.ts` resolves every `/api/**` request
 * against this table BEFORE `resolve(event)` runs. Any path matching NO rule
 * is denied (403) -- a newly added endpoint is closed by construction until a
 * policy line opens it, which is the structural fix for the "the gate
 * existed but the route never called it" leak class (cairn's viewer-sees-
 * raw-PSBT bug, WALLET-ENGINE.md §5.3).
 *
 * First match wins; keep specific patterns before general ones. This table
 * MUST stay in sync with the actual route tree -- src/routes/api/policy-
 * parity.spec.ts asserts every `+server.ts` file resolves to a non-null rule.
 */
import type { Role } from './index.js';

export type MinRole = 'public' | 'authed' | Role;

export interface Rule {
	pattern: RegExp;
	methods?: string[];
	min: MinRole;
}

// FIRST match wins; order specific-before-general. Anything under /api not
// matched here is DENIED (see resolveApiPolicy's null return).
export const API_POLICY: Rule[] = [
	{ pattern: /^\/api\/health$/, min: 'public' },
	{ pattern: /^\/api\/events$/, min: 'guest' }, // any authed; scope filter narrows (§3.5)
	{ pattern: /^\/api\/me(\/|$)/, min: 'authed' }, // self-scoped in handler
	{ pattern: /^\/api\/chain(\/|$)/, min: 'guest' },
	{ pattern: /^\/api\/mining\/pool$/, min: 'guest' },
	{ pattern: /^\/api\/mining\/me$/, min: 'member' },
	{ pattern: /^\/api\/mining\/config$/, min: 'owner' },
	{ pattern: /^\/api\/wallets(\/|$)/, min: 'member' }, // + per-wallet ownership in handler (§3.4)
	{ pattern: /^\/api\/invites(\/|$)/, min: 'owner' },
	{ pattern: /^\/api\/members(\/|$)/, min: 'owner' },
	{ pattern: /^\/api\/household\/summary$/, min: 'guest' }, // aggregate only if opted in, or Owner (§3.6)
	{ pattern: /^\/api\/settings(\/|$)/, min: 'owner' }
];

/** Resolve the policy rule for a path+method. Returns null => deny-by-default. */
export function resolveApiPolicy(pathname: string, method: string): Rule | null {
	for (const r of API_POLICY) {
		if (!r.pattern.test(pathname)) continue;
		if (r.methods && !r.methods.includes(method)) continue;
		return r;
	}
	return null;
}
