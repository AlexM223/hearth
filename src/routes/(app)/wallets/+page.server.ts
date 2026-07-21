/**
 * Wallets list loader (WALLET-ENGINE §3.3). Owner-scoped: lists the caller's
 * wallets with their SWR balance snapshot -- no rail call on the page load.
 */
import type { PageServerLoad } from './$types';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';

export const load: PageServerLoad = ({ locals }) => {
	const user = locals.user;
	if (!user) return { wallets: [] };
	const wallets = listWallets(user.id).map((w) => {
		const snap = getSnapshot(w.id);
		return {
			id: w.id,
			name: w.name,
			kind: w.kind,
			scriptType: w.scriptType,
			network: w.network,
			threshold: w.threshold,
			keyCount: w.keys.length,
			confirmedSats: snap?.confirmedSats ?? 0,
			unconfirmedSats: snap?.unconfirmedSats ?? 0
		};
	});
	return { wallets };
};
