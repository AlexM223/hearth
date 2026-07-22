/**
 * POST /api/wallets/[id]/receive -- rotate to the next unused external address
 * (WALLET-ENGINE §2.3). Owner-scoped.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getWallet, nextReceiveAddress, resolveWalletRole } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { requireRole } from '$lib/server/auth/index.js';

export function POST(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'member');
	const walletId = Number(event.params.id);
	// Route-level ownership guard (WALLET-ENGINE §5.3), matching every sibling
	// /api/wallets/[id]/** endpoint: a non-owner gets a uniform 404 (no leak),
	// same as GET /api/wallets/[id] and the drafts tree. Previously this route
	// relied solely on nextReceiveAddress's user-scoped getWalletRow lookup in
	// the service layer -- defense-in-depth now catches it at the route too.
	const wallet = getWallet(user.id, walletId);
	if (resolveWalletRole(user.id, wallet) !== 'owner') throw error(404, 'wallet not found');
	try {
		const addr = nextReceiveAddress(user.id, walletId);
		return json({ address: addr.address, index: addr.index, chain: addr.chain });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
