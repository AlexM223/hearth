/**
 * Sequential one-shot migration runner (nodeview/cairn idiom, DECISIONS.md
 * §2, §4.8). Schema is idempotent `CREATE TABLE IF NOT EXISTS` inside each
 * migration; `_migrations` just records which ones have already run so they
 * are never re-applied.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
	/** Sequential, never reused or reordered once shipped. */
	id: number;
	name: string;
	up: (db: DatabaseSync) => void;
}

// Import order doesn't matter -- runMigrations sorts by id.
import { migration001Init } from './migrations/001_init.js';

const migrations: Migration[] = [migration001Init];

/** Applies every migration that hasn't run yet, in id order, inside its own transaction. */
export function runMigrations(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const applied = new Set(
		(db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((row) => row.id)
	);

	const pending = [...migrations].sort((a, b) => a.id - b.id);
	for (const migration of pending) {
		if (applied.has(migration.id)) continue;

		db.exec('BEGIN IMMEDIATE');
		try {
			migration.up(db);
			db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(
				migration.id,
				migration.name
			);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}
}

/** Exposed for tests/diagnostics -- the full ordered migration list. */
export function listMigrations(): readonly Migration[] {
	return migrations;
}
