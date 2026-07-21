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
import { getLastKnownTip } from '$lib/server/node/watcher.js';

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
			keyCount: wallet.keys.length,
			// Cosigner xpubs/fingerprints/paths -- needed browser-side to build a
			// Ledger/Trezor wallet policy for multisig signing (SIGNING.md §1.1,
			// §1.2). These are the owner's own already-known public key material,
			// never a secret; still owner-scoped by this same load's role check.
			keys: wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path, name: k.name ?? null }))
		},
		balance: getBalance(walletId, syncNode),
		snapshot: getSnapshot(walletId, syncNode),
		history: getHistory(walletId, 50, syncNode),
		utxos: getUtxos(walletId, syncNode),
		receiveAddress: receive?.address ?? null,
		// Synchronous best-effort tip -- lets History show an approximate age
		// per confirmation depth without an async node round-trip.
		tipHeight: getLastKnownTip()
	};
};
