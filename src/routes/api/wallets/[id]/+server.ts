/**
 * /api/wallets/[id] -- wallet detail (balance/history/utxos/addresses, SWR) and
 * delete. Owner-scoped: a non-owner gets 404 (no leak). GET triggers a
 * background refresh via the node when stale.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import {
	getWallet,
	getBalance,
	getHistory,
	getUtxos,
	getSnapshot,
	deleteWallet,
	deriveAddresses,
	resolveWalletRole
} from '$lib/server/wallet/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import { requireRole } from '$lib/server/auth/index.js';

// Explicit org-role floor (defense in depth, matching /api/wallets's own
// requireRole('member') -- Layer 1 in hooks.server.ts already requires
// 'member' for every /api/wallets/** path, but this keeps the route safe
// even if that policy line were ever dropped).
function requireUser(event: RequestEvent): { id: number } {
	const user = requireRole(event.locals.user, 'member');
	return { id: user.id };
}

export function GET(event: RequestEvent) {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const wallet = getWallet(user.id, walletId);
	if (resolveWalletRole(user.id, wallet) === 'none' || !wallet) throw error(404, 'wallet not found');

	// SWR: pass the node so a stale/dirty snapshot kicks a background refresh.
	let node;
	try {
		node = getNodeClient();
	} catch {
		node = undefined;
	}
	const syncNode = node ? { electrum: node.electrum, tipHeight: null } : undefined;

	return json({
		wallet: {
			id: wallet.id,
			name: wallet.name,
			kind: wallet.kind,
			scriptType: wallet.scriptType,
			network: wallet.network,
			threshold: wallet.threshold,
			keys: wallet.keys.map((k) => ({ position: k.position, fingerprint: k.fingerprint, path: k.path, name: k.name })),
			receiveCursor: wallet.receiveCursor
		},
		balance: getBalance(walletId, syncNode),
		snapshot: getSnapshot(walletId, syncNode),
		history: getHistory(walletId, 50, syncNode),
		utxos: getUtxos(walletId, syncNode),
		receiveAddresses: deriveAddresses(wallet, 0, wallet.receiveCursor, 1)
	});
}

export function DELETE(event: RequestEvent) {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const ok = deleteWallet(user.id, walletId);
	if (!ok) throw error(404, 'wallet not found');
	return json({ deleted: true });
}
