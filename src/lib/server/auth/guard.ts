/**
 * The role-check helper (COME-ABOARD.md §3.3, Layer 2 -- defense in depth).
 * `hooks.server.ts` calls resolveApiPolicy + roleAtLeast at the edge
 * (Layer 1, deny-by-default); every handler ALSO calls requireRole (or
 * roleAtLeast directly) so a route stays safe even if a future refactor
 * drops its policy line, and so service code invoked off a route (the SSE
 * bridge, mining engine, tests) enforces the same rule.
 */
import { error } from '@sveltejs/kit';
import type { Role } from './index.js';
import type { SessionUser } from './session.js';
import type { MinRole } from './policy.js';
import { getWallet, resolveWalletRole } from '$lib/server/wallet/index.js';

const RANK: Record<Role, number> = { guest: 1, member: 2, owner: 3 };

/** Whether `u` (possibly anonymous) meets the minimum role `min`. */
export function roleAtLeast(u: SessionUser | null, min: MinRole): boolean {
	if (min === 'public') return true;
	if (!u) return false;
	if (min === 'authed') return true;
	return RANK[u.role] >= RANK[min as Role];
}

/** Throws 401 if there's no session, 403 if the session doesn't meet `min`.
 *  `min` here is never 'public' -- a public route has nothing to require. */
export function requireRole(user: SessionUser | null, min: Exclude<MinRole, 'public'>): SessionUser {
	if (!user) throw error(401, 'sign in first');
	if (!roleAtLeast(user, min)) throw error(403, 'forbidden');
	return user;
}

/**
 * Wallet ownership gate -- the resource half of the AND (COME-ABOARD.md
 * §3.3's Layer 2, WALLET-ENGINE.md §5.3): the org role permits the SURFACE
 * (checked above), this checks the caller owns the specific RESOURCE. Hearth
 * wallets are single-user-owned (`wallets.user_id`) through M3 -- multisig
 * cosigner cross-user access (`assigned_user_id`) is a WALLET-ENGINE seam
 * that stays a metadata-only column until a dedicated design lands, so
 * `need` is accepted for that future extension but every level currently
 * collapses to the same ownership check 404s uniformly on any foreign wallet
 * (no leak of existence -- WALLET-ENGINE §5.3's "uniform 404" rule).
 */
export function requireWalletAccess(
	userId: number,
	walletId: number,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	need: 'read' | 'sign' | 'own'
): void {
	const wallet = getWallet(userId, walletId);
	if (resolveWalletRole(userId, wallet) === 'none' || !wallet) throw error(404, 'wallet not found');
}
