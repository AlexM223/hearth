/**
 * POST /api/wallets/[id]/drafts/[draftId]/broadcast -- THE send action (owner
 * only). Calls the ONE broadcast path; on success publishes a `wallet` SSE frame
 * scoped to the owner (publish never reads SQLite -- the data is in hand).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getWallet, broadcastDraft, resolveWalletRole } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { getNodeClient } from '$lib/server/node/index.js';
import { publish } from '$lib/server/events/index.js';

export async function POST(event: RequestEvent) {
	const user = event.locals.user;
	if (!user) throw error(401, 'sign in first');
	const walletId = Number(event.params.id);
	const draftId = Number(event.params.draftId);
	const wallet = getWallet(user.id, walletId);
	if (resolveWalletRole(user.id, wallet) !== 'owner') throw error(404, 'not found');

	let body: { psbt?: string } = {};
	try {
		body = (await event.request.json()) as { psbt?: string };
	} catch {
		// no body is fine -- the draft may already carry enough signatures
	}
	const node = getNodeClient();
	try {
		const result = await broadcastDraft(node, user.id, walletId, draftId, body.psbt);
		// Watchtower SSE (scoped to the owner). All frame data is in hand.
		publish('wallet', { kind: 'user', userId: user.id }, {
			event: 'broadcast',
			walletId,
			draftId,
			txid: result.txid,
			duplicate: result.duplicate
		});
		return json(result);
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
