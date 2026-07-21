/**
 * Migration 002: `sessions` (password-auth tokens, DECISIONS.md §4.3) and
 * `invites` (schema now, come-aboard flow lands in M3 -- DECISIONS.md §4.8).
 * Session tokens and invite codes are both stored hashed, never plaintext.
 */
import type { Migration } from '../migrations.js';

export const migration002SessionsInvites: Migration = {
	id: 2,
	name: 'sessions + invites',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				token_hash TEXT NOT NULL UNIQUE,
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				expires_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

			CREATE TABLE IF NOT EXISTS invites (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code_hash TEXT NOT NULL UNIQUE,
				role TEXT NOT NULL CHECK (role IN ('member', 'guest')),
				created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				max_uses INTEGER NOT NULL DEFAULT 1,
				used_count INTEGER NOT NULL DEFAULT 0,
				revoked INTEGER NOT NULL DEFAULT 0,
				expires_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}
};
