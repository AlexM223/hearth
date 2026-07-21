/**
 * spvVerifyConfirmed -- the fail-closed SPV gate (WATCHTOWER.md §1.2,
 * DECISIONS.md §4.9 invariant 3). Returns true ONLY when a tx is provably
 * sitting in a PoW-valid block above the difficulty floor; every other
 * outcome (a throw, a cache mismatch, a cold cache) returns false. A
 * deferred (false) result is never written to the ledger, so the next
 * scripthash/header event retries automatically -- no explicit retry queue
 * needed on the detection side.
 *
 * Shared by detect/watcher.ts (a tx's first confirmation) and
 * detect/confirm.ts (T2: re-verified at each deeper milestone) -- kept in
 * its own file (a documented structural deviation from WATCHTOWER.md's
 * module list, which folds this into watcher.ts) purely to avoid a
 * watcher.ts <-> confirm.ts import cycle; the algorithm is exactly §1.2's.
 *
 * Reuses wallet/index.ts's verifyTxInclusion + parseBlockHeader for every
 * merkle/PoW check -- adds none of its own (the reuse boundary,
 * notify/spvSingleSource.spec.ts).
 */
import { verifyTxInclusion, parseBlockHeader } from '$lib/server/wallet/index.js';
import { DIFFICULTY_FLOOR_FACTOR, type DifficultyFloor } from './difficulty.js';

export interface SpvMerkleProof {
	merkle: string[];
	pos: number;
}

/** The narrow Electrum surface the SPV gate needs. */
export interface SpvElectrumRail {
	getMerkleProof(txid: string, height: number): Promise<SpvMerkleProof>;
	getBlockHeader(height: number): Promise<string>;
}

export async function spvVerifyConfirmed(
	rail: SpvElectrumRail,
	floor: DifficultyFloor,
	txid: string,
	height: number
): Promise<boolean> {
	// 1. mempool (height<=0): no proof can exist.
	if (!Number.isInteger(height) || height <= 0) return false;

	// 2. fetch proof + header (both on the caller's background lane -- the
	//    rail passed in already resolves to that lane; see watcher.ts).
	let proof: SpvMerkleProof;
	let headerHex: string;
	try {
		[proof, headerHex] = await Promise.all([rail.getMerkleProof(txid, height), rail.getBlockHeader(height)]);
	} catch {
		return false; // Electrum down / request threw -- defer, retry later
	}

	const parsed = parseBlockHeader(headerHex);
	if (!parsed) return false; // unparseable header -- defer

	// 3. Snapshot the PRE-EXISTING cache state before this fetch can influence
	//    it (a header must never validate itself).
	const pinned = floor.cachedHeader(height);
	const sizeBeforeThisFetch = floor.size();
	const priorHardestTarget = floor.maxTarget();

	if (pinned && parsed.hash !== pinned.hash) {
		// Forged header OR a real reorg -- DEFER, never blacklist (a real reorg
		// self-resolves on the next block; see detect/confirm.ts, T2).
		return false;
	}
	if (!pinned && sizeBeforeThisFetch === 0) {
		// Cold cache at startup -- defer until warm, never guess.
		return false;
	}

	// Grow the rolling cache with this fetched header too (WATCHTOWER.md §1.3:
	// "on each header fetched during verification"). Safe regardless of
	// outcome so far -- acceptHeader independently re-validates self-
	// consistency + the implausible-weakness guard.
	floor.acceptHeader(height, headerHex);

	const maxTarget = pinned ? undefined : priorHardestTarget * DIFFICULTY_FLOOR_FACTOR;
	const tipHeight = floor.tipHeight();

	const res = verifyTxInclusion({
		txid,
		height,
		proof: proof.merkle,
		pos: proof.pos,
		headerHex,
		tipHeight,
		maxTarget
	});
	return res.ok;
}
