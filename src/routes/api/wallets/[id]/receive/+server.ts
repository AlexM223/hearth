/**
 * POST /api/wallets/[id]/receive -- rotate to the next unused external address
 * (WALLET-ENGINE §2.3). Owner-scoped.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { nextReceiveAddress } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';

export function POST(event: RequestEvent) {
	const user = event.locals.user;
	if (!user) throw error(401, 'sign in first');
	const walletId = Number(event.params.id);
	try {
		const addr = nextReceiveAddress(user.id, walletId);
		return json({ address: addr.address, index: addr.index, chain: addr.chain });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
