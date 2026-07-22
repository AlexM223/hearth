/**
 * POST /api/wallets/[id]/drafts/[draftId]/abandon -- cancel a draft, freeing its
 * reserved inputs (owner only).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getWallet, abandonDraft, resolveWalletRole } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { requireRole } from '$lib/server/auth/index.js';

export function POST(event: RequestEvent) {
	// Explicit org-role floor (defense in depth) before the resource-level
	// ownership check below -- matches /api/wallets's requireRole('member').
	const user = requireRole(event.locals.user, 'member');
	const walletId = Number(event.params.id);
	const draftId = Number(event.params.draftId);
	if (resolveWalletRole(user.id, getWallet(user.id, walletId)) !== 'owner') throw error(404, 'not found');
	try {
		const ok = abandonDraft(user.id, walletId, draftId);
		return json({ abandoned: ok });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
