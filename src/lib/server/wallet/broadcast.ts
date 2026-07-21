/**
 * THE one broadcast path (DECISIONS.md §0.3 rule 3, §4.2; WALLET-ENGINE §5.4,
 * §6.3). This module is the ONLY place in the wallet engine that reaches the
 * broadcast rail (node.broadcast), and it does so at EXACTLY ONE call site.
 * Heartwood had three broadcast entry points; Hearth has one, guarded by a
 * static regression test (broadcast.single-path.spec.ts).
 *
 * Pipeline (kind-blind; the ScriptEngine is injected):
 *   1. friendly already-sent guard (racy; the atomic claim is the real gate)
 *   2. preparePsbt: single-sig normalize + assertSameTransaction; multisig combine
 *   3. finalize (engine): raw bytes + deterministic LOCAL txid; multisig quorum-gate
 *   4. early duplicate short-circuit -> superseded, no network
 *   5. atomic claim (SQL) -> else AlreadyBroadcastError
 *   6. node.broadcast(rawHex)  <-- THE ONE CALL SITE
 *   7. txid verify: reported != local -> release claim, refuse (anti-forgery)
 *   8. late duplicate re-check
 *   9. mark broadcast + supersede any replaced original + mark wallet dirty
 */
import type { ScriptEngine } from './script/engine.js';
import { selectEngine } from './script/engine.js';
import { assertSameTransaction } from './psbt.js';
import {
	getDraftRow,
	getWalletRow,
	claimBroadcast,
	releaseBroadcastClaim,
	markBroadcast,
	markSuperseded,
	findBroadcastByTxid,
	findDraftByReplacesTxid
} from './repo.js';
import { markWalletDirty } from './sync.js';
import { AlreadyBroadcastError, NotFoundError, WalletError } from './errors.js';
import type { DraftRow, Wallet } from './types.js';

/** The narrow node surface the broadcast path needs. */
export interface BroadcastNode {
	broadcast(rawTxHex: string): Promise<string>;
}

export interface BroadcastResult {
	txid: string;
	duplicate: boolean;
	message?: string;
}

/** Prepare the PSBT to finalize: merge any ride-along final signature. Single-sig
 *  validates same-transaction and adopts it; multisig combines (which itself runs
 *  the same-tx + foreign-sig + sighash guards). */
function preparePsbt(
	engine: ScriptEngine,
	wallet: Wallet,
	draft: DraftRow,
	finalSignedPsbtBase64?: string
): string {
	if (!finalSignedPsbtBase64) return draft.psbt;
	if (wallet.kind === 'single') {
		assertSameTransaction(draft.psbt, finalSignedPsbtBase64);
		return finalSignedPsbtBase64;
	}
	if (!engine.combine) throw new WalletError('multisig engine cannot combine');
	return engine.combine(draft.psbt, finalSignedPsbtBase64);
}

/** THE broadcast function. Owner-only (getWalletRow scopes to the owner). */
export async function broadcastDraft(
	node: BroadcastNode,
	userId: number,
	walletId: number,
	draftId: number,
	finalSignedPsbtBase64?: string
): Promise<BroadcastResult> {
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new NotFoundError('wallet not found');
	const draft = getDraftRow(walletId, draftId);
	if (!draft) throw new NotFoundError('draft not found');
	const engine = selectEngine(wallet);

	// 1. Friendly already-sent guard (racy; the claim below is the real gate).
	if (draft.status === 'broadcast' || draft.status === 'confirmed') {
		if (draft.txid) return { txid: draft.txid, duplicate: true, message: 'already broadcast' };
		throw new AlreadyBroadcastError();
	}
	if (draft.status === 'superseded' || draft.status === 'abandoned') {
		throw new AlreadyBroadcastError('this draft is no longer sendable');
	}

	// 2. Prepare + 3. finalize -> deterministic LOCAL txid.
	const preparedPsbt = preparePsbt(engine, wallet, draft, finalSignedPsbtBase64);
	const { rawHex, txid: localTxid } = engine.finalize(preparedPsbt);

	// 4. Early duplicate short-circuit: another sent draft already has this txid.
	const dupId = findBroadcastByTxid(walletId, localTxid);
	if (dupId != null && dupId !== draftId) {
		markSuperseded(walletId, draftId);
		return { txid: localTxid, duplicate: true, message: 'an identical transaction was already sent' };
	}

	// 5. Atomic claim -- exactly one concurrent caller proceeds to the network.
	if (!claimBroadcast(walletId, draftId)) {
		throw new AlreadyBroadcastError();
	}

	// 6. THE ONE broadcast call site in the entire wallet engine.
	let reported: string;
	try {
		reported = await node.broadcast(rawHex);
	} catch (err) {
		// Unrecoverable rejection: release the claim (stays retryable), surface friendly.
		releaseBroadcastClaim(walletId, draftId);
		const msg = err instanceof Error ? err.message : String(err);
		throw new WalletError(`the network rejected this transaction: ${msg.slice(0, 200)}`);
	}

	// 7. txid verification (anti-forgery): a malicious server cannot forge a txid.
	if (typeof reported === 'string' && reported.toLowerCase() !== localTxid.toLowerCase()) {
		releaseBroadcastClaim(walletId, draftId);
		throw new WalletError('the node reported a different transaction id than we computed; refusing to record');
	}

	// 8. Late duplicate re-check (closes the concurrent byte-identical window).
	const lateDup = findBroadcastByTxid(walletId, localTxid);
	if (lateDup != null && lateDup !== draftId) {
		markSuperseded(walletId, draftId);
		return { txid: localTxid, duplicate: true, message: 'an identical transaction was already sent' };
	}

	// 9. Record broadcast; supersede any RBF-replaced original (best-effort); dirty.
	markBroadcast(walletId, draftId, localTxid, preparedPsbt);
	if (draft.replacesTxid) {
		try {
			const replacedId = findDraftByReplacesTxid(walletId, draft.replacesTxid);
			if (replacedId != null && replacedId !== draftId) markSuperseded(walletId, replacedId);
		} catch {
			// best-effort; the send already succeeded
		}
	}
	markWalletDirty(walletId);

	return { txid: localTxid, duplicate: false };
}
