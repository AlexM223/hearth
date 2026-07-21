/**
 * SPV-verified confirmation (WALLET-ENGINE §5.5; DECISIONS.md §4.9 invariant 3).
 * Moves a `broadcast` draft to `confirmed` ONLY on a valid tx-inclusion proof
 * (merkle branch reproduces a PoW-valid header at/under the difficulty floor).
 * Fail closed: an unverifiable tx never advances to confirmed (no false
 * positive). The notify module (M6) drives this from scripthash subscriptions;
 * the height is supplied by the caller (from the tx's Electrum status).
 */
import { verifyTxInclusion, type SpvResult } from './spv.js';
import { getDraftRow, markConfirmed } from './repo.js';

export interface ConfirmNode {
	getMerkleProof(
		txid: string,
		height: number
	): Promise<{ block_height: number; merkle: string[]; pos: number }>;
	getBlockHeader(height: number): Promise<string>;
}

/** Verify a broadcast draft's tx inclusion and, on success, mark it confirmed. */
export async function confirmDraft(
	node: ConfirmNode,
	walletId: number,
	draftId: number,
	height: number,
	opts?: { tipHeight: number; maxTarget?: bigint }
): Promise<SpvResult> {
	const draft = getDraftRow(walletId, draftId);
	if (!draft || !draft.txid) return { ok: false, reason: 'unconfirmed' };
	if (draft.status !== 'broadcast' && draft.status !== 'confirmed') {
		return { ok: false, reason: 'unconfirmed' };
	}

	const [proof, headerHex] = await Promise.all([
		node.getMerkleProof(draft.txid, height),
		node.getBlockHeader(height)
	]);
	const result = verifyTxInclusion({
		txid: draft.txid,
		height,
		proof: proof.merkle,
		pos: proof.pos,
		headerHex,
		tipHeight: opts?.tipHeight ?? height,
		maxTarget: opts?.maxTarget
	});
	if (result.ok) markConfirmed(walletId, draftId);
	return result;
}
