/**
 * T0 acceptance (EXPLORER.md §1.8, §7 T0): migration 006 applies idempotently
 * on a fresh AND an already-migrated DB, and the table's single-row-only
 * shape (id CHECK = 1) is enforced -- the upsert-only contract
 * `refreshExplorerSnapshot` relies on (snapshot.spec.ts, T6).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations.js';

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	return db;
}

describe('migration 006: explorer_snapshot (wipe-safe SWR cache)', () => {
	it('creates the explorer_snapshot table', () => {
		const db = freshDb();
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
		).map((t) => t.name);
		expect(names).toContain('explorer_snapshot');
	});

	it('is idempotent -- running migrations twice never throws', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
	});

	it('allows exactly one row (id CHECK = 1), upsert-only', () => {
		const db = freshDb();
		db.prepare(
			'INSERT INTO explorer_snapshot (id, data, synced_at) VALUES (1, ?, ?)'
		).run('{}', new Date().toISOString());

		expect(() =>
			db.prepare('INSERT INTO explorer_snapshot (id, data, synced_at) VALUES (2, ?, ?)').run(
				'{}',
				new Date().toISOString()
			)
		).toThrow();

		expect(() =>
			db
				.prepare(
					'INSERT INTO explorer_snapshot (id, data, synced_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at'
				)
				.run('{"updated":true}', new Date().toISOString())
		).not.toThrow();

		const row = db.prepare('SELECT data FROM explorer_snapshot WHERE id = 1').get() as { data: string };
		expect(JSON.parse(row.data)).toEqual({ updated: true });
	});

	it('a missing row is a plain empty result, never a thrown error (the wipe-safe contract)', () => {
		const db = freshDb();
		const row = db.prepare('SELECT data FROM explorer_snapshot WHERE id = 1').get();
		expect(row).toBeUndefined();
	});
});
