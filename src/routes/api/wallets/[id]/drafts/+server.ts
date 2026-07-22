/**
 * /api/wallets/[id]/drafts -- GET lists the wallet's drafts (owner: summaries;
 * a non-owner never reaches here -> 404). POST builds a PSBT (the send path).
 * PSBT-bearing: role-gated at the route layer (WALLET-ENGINE §5.3).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import {
	getWallet,
	listDrafts,
	buildPsbt,
	draftSummary,
	resolveWalletRole,
	reservationWarnings,
	type BuildRequest
} from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { getNodeClient } from '$lib/server/node/index.js';
import { requireRole } from '$lib/server/auth/index.js';

function requireOwner(event: RequestEvent): { userId: number; walletId: number } {
	// Explicit org-role floor (defense in depth) before the resource-level
	// ownership check below -- matches /api/wallets's requireRole('member').
	const user = requireRole(event.locals.user, 'member');
	const walletId = Number(event.params.id);
	const wallet = getWallet(user.id, walletId);
	// Non-owner (or absent) => 404 with NO PSBT-bearing content (no leak, §5.3).
	if (resolveWalletRole(user.id, wallet) !== 'owner') throw error(404, 'wallet not found');
	return { userId: user.id, walletId };
}

export function GET(event: RequestEvent) {
	const { walletId } = requireOwner(event);
	// Summaries only -- never the raw psbt bytes, even for the owner list view.
	return json({ drafts: listDrafts(walletId).map(draftSummary) });
}

export async function POST(event: RequestEvent) {
	const { userId, walletId } = requireOwner(event);
	let body: BuildRequest;
	try {
		body = (await event.request.json()) as BuildRequest;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	const node = getNodeClient();
	const buildNode = {
		electrum: node.electrum,
		tipHeight: null,
		getMinFeeRate: () => node.getMinFeeRate(),
		fetchRawTx: (txid: string) => node.fetchRawTx(txid)
	};
	try {
		const built = await buildPsbt(buildNode, userId, walletId, body);
		const warnings = body.onlyUtxos ? reservationWarnings(userId, body.onlyUtxos) : [];
		// The owner (builder) legitimately receives the PSBT bytes to sign.
		return json({ draftId: built.draftId, psbt: built.psbtBase64, review: built.review, warnings }, { status: 201 });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
