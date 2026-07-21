/**
 * Pure, testable slice of the first-30-seconds choreography (COME-ABOARD.md
 * §2.5) -- pulled out of +page.server.ts so it doesn't need a live
 * NodeClient to unit-test. Owner's hero is always their own balance
 * (they're the host, never "aboard" someone else's node); a Guest never
 * holds a wallet so their hero stays the aboard message; a Member's hero
 * flips from aboard-message to their own balance the moment they hold ≥1
 * wallet.
 */
import type { Role } from '$lib/server/auth/index.js';

export type HeroKind = 'aboard' | 'balance';

export function heroKindFor(role: Role, walletCount: number): HeroKind {
	return role !== 'owner' && walletCount === 0 ? 'aboard' : 'balance';
}
