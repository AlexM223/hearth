/**
 * Migration 003: `events` -- the activity feed AND the watchtower's SSE
 * replay source (DECISIONS.md §4.8). The five-channel notifier (M6) is the
 * eventual writer; Home's watchtower-feed skeleton (M1) only needs to read
 * an empty table gracefully, so the schema lands now rather than waiting.
 */
import type { Migration } from '../migrations.js';

export const migration003Events: Migration = {
	id: 3,
	name: 'events (activity feed)',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
				level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'danger')),
				title TEXT NOT NULL,
				body TEXT,
				detail TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
		`);
	}
};
