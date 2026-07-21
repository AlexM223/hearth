import { fail } from '@sveltejs/kit';
import { describeNodeHealth, getNodeClient } from '$lib/server/node/index.js';
import { listRecentEvents } from '$lib/server/notify/index.js';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';
import {
	householdGreetingName,
	hasBeenWelcomed,
	markWelcomed,
	householdSummary,
	guestSeesHouseholdBalance,
	type WalletBalanceReader
} from '$lib/server/auth/index.js';
import { heroKindFor } from './home-choreography.js';
import type { Actions, PageServerLoad } from './$types';

const readBalances: WalletBalanceReader = (userId) =>
	listWallets(userId).map((w) => {
		const snap = getSnapshot(w.id);
		return { confirmedSats: snap?.confirmedSats ?? 0, unconfirmedSats: snap?.unconfirmedSats ?? 0 };
	});

/** Home = the hearth (DECISIONS.md §4.2): live tip height, plain-language
 *  node health, the watchtower-feed skeleton, and the first-30-seconds
 *  choreography (COME-ABOARD.md §2.5): a fresh invitee's hero reads
 *  "You're aboard <captain>'s node" until they hold a wallet, then their own
 *  balance takes over -- a Guest never gets a wallet so their hero stays the
 *  aboard message permanently (household-balance opt-in is T12's
 *  guest.seeHouseholdBalance seam, off by default). */
export const load: PageServerLoad = async ({ locals }) => {
	const node = getNodeClient();
	const health = await node.health();
	const user = locals.user!; // the (app) group guard guarantees a session here

	let confirmedSats = 0;
	let unconfirmedSats = 0;
	let walletCount = 0;
	if (user.role !== 'guest') {
		const wallets = listWallets(user.id);
		walletCount = wallets.length;
		for (const w of wallets) {
			const snap = getSnapshot(w.id);
			confirmedSats += snap?.confirmedSats ?? 0;
			unconfirmedSats += snap?.unconfirmedSats ?? 0;
		}
	}

	return {
		health,
		healthText: describeNodeHealth(health),
		feed: listRecentEvents(20),
		captain: householdGreetingName(),
		walletCount,
		heroKind: heroKindFor(user.role, walletCount),
		ownBalance: { confirmedSats, unconfirmedSats },
		// Owner is never a "fresh invitee" (first-run bootstrap, not an invite
		// accept) -- the ribbon is a Member/Guest-only welcome.
		showWelcome: user.role !== 'owner' && !hasBeenWelcomed(user.id),
		// Household cross-member roll-up (COME-ABOARD.md §4) -- Owner only,
		// read-only, computed fresh on every load (same SWR-synchronous pattern
		// as the wallets list; refreshed live by the existing 'block' broadcast
		// tick rather than a dedicated push, see T10's close-out note).
		household: user.role === 'owner' ? householdSummary(readBalances) : null,
		// Guest household-balance opt-in (§3.6, default OFF): aggregate ONLY,
		// never a member breakdown -- same householdSummary reader, just a
		// narrower projection for a Guest than the Owner's panel gets.
		guestHouseholdBalance:
			user.role === 'guest' && guestSeesHouseholdBalance()
				? { confirmedSats: householdSummary(readBalances).confirmedSats }
				: null
	};
};

export const actions: Actions = {
	dismissWelcome: ({ locals }) => {
		if (!locals.user) return fail(401);
		markWelcomed(locals.user.id);
		return {};
	}
};
