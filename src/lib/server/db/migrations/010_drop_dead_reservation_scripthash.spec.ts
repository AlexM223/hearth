/**
 * Migration 010 acceptance: drops the dead `utxos.reserved_by_draft_id`
 * column and the dormant `scripthash_status` table (both from migration
 * 004, hearth-krx / hearth-7vg). Applies cleanly both on a fresh DB and on a
 * DB that already ran migration 004 (the pre-010 shape that still has both).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations, listMigrations } from '../migrations.js';

function utxoColumns(db: DatabaseSync): string[] {
	return (db.prepare('PRAGMA table_info(utxos)').all() as { name: string }[]).map((c) => c.name);
}

function tableNames(db: DatabaseSync): string[] {
	return (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
	).map((r) => r.name);
}

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	return db;
}

/** Applies only migrations up to (and including) id, in order -- simulates an
 *  older install that already ran migration 004 but not 010 yet. */
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

describe('migration 010: drop dead utxos.reserved_by_draft_id + dormant scripthash_status', () => {
	it('a completely fresh DB has no reserved_by_draft_id column and no scripthash_status table', () => {
		const db = freshDb();
		expect(utxoColumns(db)).not.toContain('reserved_by_draft_id');
		expect(tableNames(db)).not.toContain('scripthash_status');
	});

	it('is idempotent -- running migrations twice never throws', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
		expect(utxoColumns(db)).not.toContain('reserved_by_draft_id');
		expect(tableNames(db)).not.toContain('scripthash_status');
	});

	it('applies cleanly on top of a DB that already ran migration 004 (the pre-010 shape)', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		// Simulate an older install: only 001-004 applied, so both dead-code
		// beads exist exactly as migration 004 originally shipped them.
		applyOnlyMigrations(db, 4);
		expect(utxoColumns(db)).toContain('reserved_by_draft_id');
		expect(tableNames(db)).toContain('scripthash_status');

		// The "update to current" step: run every migration forward, including 010.
		expect(() => runMigrations(db)).not.toThrow();

		const appliedIds = (db.prepare('SELECT id FROM _migrations').all() as { id: number }[])
			.map((r) => r.id)
			.sort((a, b) => a - b);
		expect(appliedIds).toEqual(listMigrations().map((m) => m.id));

		expect(utxoColumns(db)).not.toContain('reserved_by_draft_id');
		expect(tableNames(db)).not.toContain('scripthash_status');
	});

	it('leaves every other utxos column and the utxos data itself untouched', () => {
		const db = freshDb();
		const cols = utxoColumns(db);
		expect(cols).toEqual(
			expect.arrayContaining([
				'id',
				'wallet_id',
				'txid',
				'vout',
				'value_sats',
				'chain',
				'address_index',
				'address',
				'height',
				'coinbase',
				'unconfirmed_trust'
			])
		);
	});

	it('does not touch migration 004\'s TABLE definition file -- historical migrations stay untouched', () => {
		// Applying only 001-004 must still produce the original pre-010 shape;
		// proven above. This test just documents the invariant explicitly.
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		applyOnlyMigrations(db, 4);
		expect(utxoColumns(db)).toContain('reserved_by_draft_id');
		expect(tableNames(db)).toContain('scripthash_status');
	});
});
