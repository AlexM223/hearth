/**
 * GET /api/members -- the Owner-sees-all cross-member roll-up (COME-ABOARD.md
 * §4, §6.2). Owner-only. Read-only: balances only, never a draft/address/
 * xpub/credential (asserted by members.spec.ts's structural key-set check
 * and by this route never importing psbt/address-bearing wallet exports).
 */
import { json, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { listMembers, type WalletBalanceReader } from '$lib/server/auth/members.js';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';

/** Balance-only bridge into the wallet module's own SWR reader -- no rail
 *  call on this page load (same synchronous-snapshot pattern the wallets
 *  list page uses), and nothing beyond confirmed/unconfirmed sats crosses
 *  this boundary. */
const readBalances: WalletBalanceReader = (userId) =>
	listWallets(userId).map((w) => {
		const snap = getSnapshot(w.id);
		return { confirmedSats: snap?.confirmedSats ?? 0, unconfirmedSats: snap?.unconfirmedSats ?? 0 };
	});

export function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	const members = listMembers(readBalances);
	return json({ members });
}
