/**
 * POST /api/wallets/[id]/drafts/[draftId]/sign -- merge an externally-produced
 * signed PSBT (WebHID / air-gap file / BBQr) into a draft.
 *
 * Owner-only for now (SIGNING.md §2.4): the eventual rule is owner OR an
 * assigned cosigner (a member whose wallet_keys row is in this draft's
 * frozen roster), but that widening is gated on M3's resolveWalletRole
 * returning cosigner roles -- M2 returns only 'owner'/'viewer'/'none'. This
 * comment marks the exact line to change when M3 lands; do NOT widen
 * `/broadcast` alongside it (that stays owner-only permanently).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getWallet, applySignature, resolveWalletRole } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { publish } from '$lib/server/events/index.js';

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
	// Belt-and-braces in-handler length gate (SIGNING.md §3.3): the
	// adapter-node BODY_SIZE_LIMIT (512K) already stops a multi-MB payload at
	// the edge with a framework 413, but a cheap length check here makes a
	// hostile payload cheaper to reject before it ever reaches applySignature.
	if (body.psbt.length > 700_000) {
		throw error(400, 'That signed transaction is unexpectedly large -- check you uploaded the right file.');
	}
	try {
		const { review, progress } = applySignature(user.id, walletId, draftId, body.psbt);
		// Watchtower SSE (CosignerProgress.svelte's live roster, SIGNING.md
		// §2.3). Scoped to the owner's own connections for now (M2 has no
		// cosigner accounts); cross-member visibility arrives with M3's role
		// widening above. Frame data is already in hand -- publish() never
		// reads SQLite (DECISIONS.md §4.5).
		publish('wallet', { kind: 'user', userId: user.id }, { event: 'sign', walletId, draftId, progress });
		return json({ review, progress });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
