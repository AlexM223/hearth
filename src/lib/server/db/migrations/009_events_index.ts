/**
 * Migration 009: replaces the dead `idx_events_created_at` (migration 003)
 * with an index that actually matches the feed's hot-path query shape
 * (notify/feed.ts's `listFeed`: `WHERE user_id = ? ... ORDER BY id DESC
 * LIMIT ?`, every role variant). Nothing in production ever queries `events`
 * filtered or ordered by `created_at` alone -- `id` is the feed's true
 * chronological/pagination key (AUTOINCREMENT), so `idx_events_created_at`
 * was pure dead weight (unused index maintenance cost on every insert).
 *
 * Historical migrations are never edited once shipped (DECISIONS.md §2) --
 * this drops what 003 created rather than rewriting 003 in place, matching
 * the update-path guarantee (an already-migrated DB just gets the diff).
 */
import type { Migration } from '../migrations.js';

export const migration009EventsIndex: Migration = {
	id: 9,
	name: 'events: drop dead idx_events_created_at, add idx_events_user_id_id',
	up(db) {
		db.exec(`
			DROP INDEX IF EXISTS idx_events_created_at;

			-- notify/feed.ts's listFeed: every role variant filters by user_id
			-- (owner: none, member/guest: user_id = ? OR ...) and ALWAYS orders
			-- by id DESC LIMIT ? -- (user_id, id) serves both the filter and the
			-- ordering directly, unlike the unused created_at index it replaces.
			CREATE INDEX IF NOT EXISTS idx_events_user_id_id ON events(user_id, id);
		`);
	}
};
