/**
 * Migration 006: `explorer_snapshot` -- the wipe-safe persisted SWR cache
 * backing the explorer index page (EXPLORER.md §1.8, DECISIONS.md §4.8).
 * Single-row upsert-only table: recent blocks + mempool summary + fee ladder
 * as one JSON blob, refreshed on a throttle by `chain/snapshot.ts`. A missing
 * row (first boot, or a wiped/corrupt DB file) is not a special case --
 * `readExplorerSnapshot()` returns null and the caller self-heals via a live
 * rail fetch, same as every other cache table in the house idiom.
 *
 * Deviation from EXPLORER.md §1.8's literal text: the spec names this file
 * "004_explorer.ts", written before M2/M3 claimed ids 4 (wallets) and 5
 * (invites/members) -- the same renumbering EXPLORER.md's own sibling doc
 * (migration005InvitesMembers's header comment) already did for exactly this
 * reason. Next free id is 6; documented here rather than silently reusing an
 * id.
 */
import type { Migration } from '../migrations.js';

export const migration006Explorer: Migration = {
	id: 6,
	name: 'explorer_snapshot (wipe-safe SWR cache for the explorer index)',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS explorer_snapshot (
				id         INTEGER PRIMARY KEY CHECK (id = 1),
				data       TEXT NOT NULL,
				synced_at  TEXT NOT NULL
			);
		`);
	}
};
