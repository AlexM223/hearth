/**
 * Wallet detail loader (WALLET-ENGINE §2.4). SWR: reads the persisted snapshot
 * synchronously and passes the node so a stale/dirty snapshot kicks a background
 * refresh -- never blocks navigation on a rail. Owner-scoped (404 otherwise).
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	getWallet,
	getBalance,
	getHistory,
	getUtxos,
	getSnapshot,
	deriveAddresses,
	resolveWalletRole
} from '$lib/server/wallet/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = locals.user;
	if (!user) throw error(401, 'sign in first');
	const walletId = Number(params.id);
	const wallet = getWallet(user.id, walletId);
	if (resolveWalletRole(user.id, wallet) === 'none' || !wallet) throw error(404, 'wallet not found');

	let syncNode: { electrum: ReturnType<typeof getNodeClient>['electrum']; tipHeight: null } | undefined;
	try {
		const node = getNodeClient();
		syncNode = { electrum: node.electrum, tipHeight: null };
	} catch {
		syncNode = undefined;
	}

	const receive = deriveAddresses(wallet, 0, wallet.receiveCursor, 1)[0];

	return {
		wallet: {
			id: wallet.id,
			name: wallet.name,
			kind: wallet.kind,
			scriptType: wallet.scriptType,
			network: wallet.network,
			threshold: wallet.threshold,
			keyCount: wallet.keys.length
		},
		balance: getBalance(walletId, syncNode),
		snapshot: getSnapshot(walletId, syncNode),
		history: getHistory(walletId, 50, syncNode),
		utxos: getUtxos(walletId, syncNode),
		receiveAddress: receive?.address ?? null
	};
};
