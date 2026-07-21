/**
 * GET /api/household/summary -- aggregate household balance (COME-ABOARD.md
 * §3.6, §6.2). Owner always sees it; a Member/Guest only when the Owner has
 * opted in (`guest.seeHouseholdBalance`, default OFF). Aggregate only --
 * never a per-member breakdown, never addresses.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole, guestSeesHouseholdBalance, householdSummary, type WalletBalanceReader } from '$lib/server/auth/index.js';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';

const readBalances: WalletBalanceReader = (userId) =>
	listWallets(userId).map((w) => {
		const snap = getSnapshot(w.id);
		return { confirmedSats: snap?.confirmedSats ?? 0, unconfirmedSats: snap?.unconfirmedSats ?? 0 };
	});

export function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'guest');
	if (user.role !== 'owner' && !guestSeesHouseholdBalance()) {
		throw error(403, 'household balance is not shared with this role');
	}
	const summary = householdSummary(readBalances);
	// Aggregate ONLY -- never per-member breakdown, never addresses (§3.6).
	return json({ confirmedSats: summary.confirmedSats, unconfirmedSats: summary.unconfirmedSats });
}
