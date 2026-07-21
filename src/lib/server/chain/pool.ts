/**
 * "You found this block" -- the M5 pool-attribution seam, built now
 * (EXPLORER.md §2, MINING-ENGINE.md §1.2). M4 ships before M5, so
 * `src/lib/server/mining/` doesn't export this query yet at build time --
 * `chain/pool.ts` reads the eventual `mining_blocks` table DIRECTLY, wrapped
 * so a missing table degrades exactly like a missing rail: never a crash,
 * never a special pre-M5 code branch anywhere else in `chain/`.
 *
 * Pre-M5 (today): the table doesn't exist, every call returns null/empty,
 * nothing crashes, no "found by" UI renders anywhere -- the explorer simply
 * looks like a non-pool-aware explorer.
 *
 * Post-M5: this seam already works with zero changes here. M5's own
 * build order may leave this file as-is (both read the identical single
 * SELECT, no drift risk) or re-point it at `mining/index.ts`'s exports --
 * either is a one-line M5 follow-up, never an M4 blocker.
 */
import { getDb } from '../db/index.js';
import { logWarn } from '../log.js';
import type { PoolAttribution } from './types.js';

interface PoolRow {
	height: number;
	block_hash: string;
	user_id: number;
	found_at: string;
	finder_name: string;
}

export function getBlockPoolAttribution(
	blockHash: string,
	viewerUserId: number | null
): PoolAttribution | null {
	try {
		const row = getDb()
			.prepare(
				`
				SELECT mb.height, mb.block_hash, mb.user_id, mb.found_at,
				       COALESCE(u.display_name, u.username) AS finder_name
				FROM mining_blocks mb JOIN users u ON u.id = mb.user_id
				WHERE mb.block_hash = ? AND mb.submit_result = 'accepted'
			`
			)
			.get(blockHash) as PoolRow | undefined;
		if (!row) return null;
		return {
			height: row.height,
			blockHash: row.block_hash,
			finderDisplayName: row.finder_name,
			isYou: viewerUserId !== null && viewerUserId === row.user_id,
			foundAt: row.found_at
		};
	} catch (e) {
		// Pre-M5: mining_blocks doesn't exist yet ("no such table"). Post-M5:
		// any other read failure. Either way, pool attribution is optional
		// garnish on top of chain data, never a page-breaking datum.
		logWarn('chain', { event: 'pool_attribution_unavailable', err: String(e) });
		return null;
	}
}

export function listPoolFoundBlockHashes(limit = 50): Set<string> {
	try {
		const rows = getDb()
			.prepare(
				`SELECT block_hash FROM mining_blocks WHERE submit_result = 'accepted' ORDER BY height DESC LIMIT ?`
			)
			.all(limit) as { block_hash: string }[];
		return new Set(rows.map((r) => r.block_hash));
	} catch {
		return new Set();
	}
}
