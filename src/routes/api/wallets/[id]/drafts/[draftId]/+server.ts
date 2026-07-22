/**
 * GET /api/wallets/[id]/drafts/[draftId] -- the review for the send screen. The
 * owner gets the PSBT bytes + review; a non-owner gets 404 (no leak, §5.3).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import {
	getWallet,
	getDraft,
	reviewSummary,
	resolveWalletRole
} from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { requireRole } from '$lib/server/auth/index.js';

export function GET(event: RequestEvent) {
	// Explicit org-role floor (defense in depth) before the resource-level
	// ownership check below -- matches /api/wallets's requireRole('member').
	const user = requireRole(event.locals.user, 'member');
	const walletId = Number(event.params.id);
	const draftId = Number(event.params.draftId);
	const wallet = getWallet(user.id, walletId);
	if (resolveWalletRole(user.id, wallet) !== 'owner') throw error(404, 'not found');
	const draft = getDraft(walletId, draftId);
	if (!draft) throw error(404, 'draft not found');
	try {
		return json({ draftId, psbt: draft.psbt, review: reviewSummary(user.id, walletId, draftId) });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
