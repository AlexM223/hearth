import { fail } from '@sveltejs/kit';
import { describeNodeHealth, getNodeClient } from '$lib/server/node/index.js';
import { listRecentEvents } from '$lib/server/notify/index.js';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';
import { householdGreetingName, hasBeenWelcomed, markWelcomed } from '$lib/server/auth/index.js';
import { heroKindFor } from './home-choreography.js';
import type { Actions, PageServerLoad } from './$types';

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
		showWelcome: user.role !== 'owner' && !hasBeenWelcomed(user.id)
	};
};

export const actions: Actions = {
	dismissWelcome: ({ locals }) => {
		if (!locals.user) return fail(401);
		markWelcomed(locals.user.id);
		return {};
	}
};
