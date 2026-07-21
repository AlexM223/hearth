/**
 * Migration 001: `meta` (kv store for schema/app-level metadata) and `users`
 * (DECISIONS.md §4.8 core schema outline, §4.3 auth). Sessions/invites/
 * wallets/etc. arrive in later migrations as those modules are built (M1-M3).
 */
import type { Migration } from '../migrations.js';

export const migration001Init: Migration = {
	id: 1,
	name: 'init: meta + users',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'guest')),
				must_reset_password INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}
};
