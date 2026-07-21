/**
 * T0 acceptance (MINING-ENGINE.md §9.3 T0): migration 007 applies idempotently
 * on a fresh AND an already-migrated DB, creates all four mining tables, and
 * `mining_stats.round_id` exists as the one dormant nullable seam
 * (DECISIONS.md §4.6) -- present, nullable, and never required by an insert.
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

describe('migration 007: mining_prefs/workers/stats/blocks', () => {
	it('creates all four mining tables', () => {
		const db = freshDb();
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
		).map((t) => t.name);
		expect(names).toContain('mining_prefs');
		expect(names).toContain('mining_workers');
		expect(names).toContain('mining_stats');
		expect(names).toContain('mining_blocks');
	});

	it('is idempotent -- running migrations twice never throws', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
	});

	it('mining_stats.round_id is nullable and unused by a normal insert (the dormant split-mode seam)', () => {
		const db = freshDb();
		expect(() =>
			db
				.prepare(
					`INSERT INTO mining_stats (bucket_start, user_id, worker_name, shares, sum_weight, hashrate_est)
					 VALUES (?, NULL, NULL, ?, ?, ?)`
				)
				.run(new Date().toISOString(), 5, 12.5, 1000)
		).not.toThrow();
		const row = db.prepare('SELECT round_id FROM mining_stats').get() as { round_id: number | null };
		expect(row.round_id).toBeNull();
	});

	it('mining_prefs.mining_id is unique', () => {
		const db = freshDb();
		db.prepare(
			`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member'), ('b', 'x', 'member')`
		).run();
		db.prepare(
			`INSERT INTO mining_prefs (user_id, mining_id, enabled) VALUES (1, 'hearth_abc', 0)`
		).run();
		expect(() =>
			db.prepare(`INSERT INTO mining_prefs (user_id, mining_id, enabled) VALUES (2, 'hearth_abc', 0)`).run()
		).toThrow();
	});

	it('mining_blocks.block_hash is unique', () => {
		const db = freshDb();
		db.prepare(
			`INSERT INTO mining_blocks (height, block_hash, payout_address, coinbase_value_sats, submit_result)
			 VALUES (100, 'aaaa', 'bcrt1qxyz', 5000000000, 'accepted')`
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO mining_blocks (height, block_hash, payout_address, coinbase_value_sats, submit_result)
					 VALUES (100, 'aaaa', 'bcrt1qxyz', 5000000000, 'accepted')`
				)
				.run()
		).toThrow();
	});
});
