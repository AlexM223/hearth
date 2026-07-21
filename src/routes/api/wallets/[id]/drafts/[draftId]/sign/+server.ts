/**
 * POST /api/wallets/[id]/drafts/[draftId]/sign -- merge an externally-produced
 * signed PSBT (WebHID / air-gap file / BBQr) into a draft. Owner/cosigner only.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getWallet, applySignature, resolveWalletRole } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';

export async function POST(event: RequestEvent) {
	const user = event.locals.user;
	if (!user) throw error(401, 'sign in first');
	const walletId = Number(event.params.id);
	const draftId = Number(event.params.draftId);
	if (resolveWalletRole(user.id, getWallet(user.id, walletId)) !== 'owner') throw error(404, 'not found');

	let body: { psbt?: string };
	try {
		body = (await event.request.json()) as { psbt?: string };
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.psbt !== 'string') throw error(400, 'a signed PSBT is required');
	try {
		const { review, progress } = applySignature(user.id, walletId, draftId, body.psbt);
		return json({ review, progress });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
