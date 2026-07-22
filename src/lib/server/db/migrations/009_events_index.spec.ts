/**
 * Migration 009 acceptance: `idx_events_created_at` (migration 003 -- unused
 * by any production query, notify/feed.ts's listFeed) is replaced by
 * `idx_events_user_id_id`, matching the feed's actual hot-path shape (WHERE
 * user_id = ? ... ORDER BY id DESC LIMIT ?). Applies cleanly both on a fresh
 * DB and on a DB that already ran migration 003 (the pre-009 shape).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations, listMigrations } from '../migrations.js';

function indexNames(db: DatabaseSync): string[] {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
			.all() as { name: string }[]
	).map((r) => r.name);
}

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	return db;
}

/** Applies only migrations up to (and including) id, in order -- simulates an
 *  older install that already ran migration 003 but not 009 yet. */
function applyOnlyMigrations(db: DatabaseSync, upToId: number): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	const older = listMigrations()
		.filter((m) => m.id <= upToId)
		.sort((a, b) => a.id - b.id);
	for (const migration of older) {
		db.exec('BEGIN IMMEDIATE');
		migration.up(db);
		db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
		db.exec('COMMIT');
	}
}

describe('migration 009: events index (drop dead idx_events_created_at, add idx_events_user_id_id)', () => {
	it('a completely fresh DB ends up with idx_events_user_id_id and WITHOUT idx_events_created_at', () => {
		const db = freshDb();
		const names = indexNames(db);
		expect(names).toContain('idx_events_user_id_id');
		expect(names).not.toContain('idx_events_created_at');
	});

	it('is idempotent -- running migrations twice never throws and the index still exists exactly once', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
		const names = indexNames(db).filter((n) => n === 'idx_events_user_id_id');
		expect(names.length).toBe(1);
	});

	it('applies cleanly on top of a DB that already ran migration 003 (the pre-009 shape)', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		// Simulate an older install: only 001-003 applied, so idx_events_created_at
		// exists exactly as migration 003 originally shipped it.
		applyOnlyMigrations(db, 3);
		expect(indexNames(db)).toContain('idx_events_created_at');
		expect(indexNames(db)).not.toContain('idx_events_user_id_id');

		// The "update to current" step: run every migration forward, including 009.
		expect(() => runMigrations(db)).not.toThrow();

		const appliedIds = (db.prepare('SELECT id FROM _migrations').all() as { id: number }[])
			.map((r) => r.id)
			.sort((a, b) => a - b);
		expect(appliedIds).toEqual(listMigrations().map((m) => m.id));

		const names = indexNames(db);
		expect(names).toContain('idx_events_user_id_id');
		expect(names).not.toContain('idx_events_created_at');
	});

	it('the new index is genuinely queryable via sqlite_master and covers (user_id, id)', () => {
		const db = freshDb();
		const row = db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_user_id_id'")
			.get() as { sql: string } | undefined;
		expect(row).toBeDefined();
		expect(row?.sql).toMatch(/events\s*\(\s*user_id\s*,\s*id\s*\)/i);
	});

	it('does not touch migration 003\'s events TABLE definition -- historical migrations stay untouched', () => {
		const db = freshDb();
		const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
		expect(cols).toEqual(
			expect.arrayContaining(['id', 'type', 'user_id', 'level', 'title', 'body', 'detail', 'created_at'])
		);
	});
});
