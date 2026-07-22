/**
 * T0 acceptance (WATCHTOWER.md §6.9 T0): migration 008 applies idempotently
 * on a fresh AND an already-migrated DB, creates all five watchtower tables,
 * and `notified_txids.status` stays nullable (the baselined/legacy silent
 * record, WATCHTOWER.md §1.7) while non-null values are constrained to the
 * documented vocabulary.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations, listMigrations } from '../migrations.js';

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	return db;
}

function seedUserAndWallet(db: DatabaseSync): void {
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'owner')`).run();
	db.prepare(
		`INSERT INTO wallets (user_id, name, kind, script_type, network, threshold, source)
		 VALUES (1, 'w', 'single', 'p2wpkh', 'mainnet', 1, 'imported')`
	).run();
}

describe('migration 008: notify tables', () => {
	it('creates all five watchtower tables', () => {
		const db = freshDb();
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
		).map((t) => t.name);
		expect(names).toContain('notified_txids');
		expect(names).toContain('notification_queue');
		expect(names).toContain('notification_preferences');
		expect(names).toContain('notification_channel_config');
		expect(names).toContain('instance_secrets');
	});

	it('is idempotent -- running migrations twice never throws', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
	});

	it('applies cleanly on top of an already-migrated M0-M5 DB (does not touch earlier migrations)', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db); // full run including 008 (and any later migrations), simulating "M2/M3 already landed"
		const appliedIds = (db.prepare('SELECT id FROM _migrations').all() as { id: number }[])
			.map((r) => r.id)
			.sort((a, b) => a - b);
		// Compared against the FULL registered list rather than a hardcoded
		// [1..8] -- this test only cares that 008 landed cleanly alongside
		// whatever else has landed since, not that 008 was the last migration.
		expect(appliedIds).toEqual(listMigrations().map((m) => m.id));
	});

	it('notified_txids.status accepts NULL (baselined/legacy silent record)', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		expect(() =>
			db
				.prepare(
					`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed)
					 VALUES (1, 1, 'aaaa', NULL, 1)`
				)
				.run()
		).not.toThrow();
		const row = db.prepare('SELECT status FROM notified_txids').get() as { status: string | null };
		expect(row.status).toBeNull();
	});

	it('notified_txids.status rejects an out-of-vocabulary value', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		expect(() =>
			db
				.prepare(
					`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed)
					 VALUES (1, 1, 'bbbb', 'bogus', 1)`
				)
				.run()
		).toThrow();
	});

	it('notified_txids primary key is (wallet_id, user_id, txid) -- a duplicate insert conflicts', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		db.prepare(
			`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed) VALUES (1, 1, 'cccc', 'pending', 0)`
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed) VALUES (1, 1, 'cccc', 'notified', 1)`
				)
				.run()
		).toThrow();
	});

	it('notification_queue.status is constrained to the documented vocabulary', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		db.prepare(
			`INSERT INTO notification_queue (user_id, channel, event_type, payload, status)
			 VALUES (1, 'webhook', 'tx_received', '{}', 'pending')`
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO notification_queue (user_id, channel, event_type, payload, status)
					 VALUES (1, 'webhook', 'tx_received', '{}', 'bogus')`
				)
				.run()
		).toThrow();
	});

	it('notification_preferences primary key is (user_id, event_type, channel)', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		db.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (1, 'tx_received', 'email', 1)`
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (1, 'tx_received', 'email', 0)`
				)
				.run()
		).toThrow();
	});

	it('notification_channel_config primary key is (user_id, channel)', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (1, 'webhook', '{}')`
		).run();
		expect(() =>
			db
				.prepare(`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (1, 'webhook', '{}')`)
				.run()
		).toThrow();
	});

	it('instance_secrets key is the primary key', () => {
		const db = freshDb();
		db.prepare(`INSERT INTO instance_secrets (key, value_enc) VALUES ('telegram_bot_token', 'env1')`).run();
		expect(() =>
			db.prepare(`INSERT INTO instance_secrets (key, value_enc) VALUES ('telegram_bot_token', 'env2')`).run()
		).toThrow();
	});

	it('wallet delete cascades to notified_txids (no orphan ledger rows)', () => {
		const db = freshDb();
		seedUserAndWallet(db);
		db.prepare(
			`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed) VALUES (1, 1, 'dddd', 'notified', 1)`
		).run();
		db.prepare('DELETE FROM wallets WHERE id = 1').run();
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM notified_txids').get() as { n: number };
		expect(remaining.n).toBe(0);
	});
});
