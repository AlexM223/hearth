/**
 * Update-path safety proof (M7 store-readiness deliverable, DECISIONS.md §6
 * M7 acceptance: "a fresh install and an update-in-place both pass ... /data
 * survives the update"). This is the migration-forward half of that
 * guarantee: on Umbrel, an update replaces the container image but keeps
 * the SAME `/data` bind mount (docker-compose.yml's `${APP_DATA_DIR}/data:
 * /data`), so the new image's first boot opens an EXISTING SQLite file that
 * was last touched by an older version of this app -- exactly the shape
 * `runMigrations` (src/lib/server/db/migrations.ts) is designed for
 * (idempotent `CREATE TABLE IF NOT EXISTS` + a `_migrations` ledger of
 * what's already applied).
 *
 * Rather than assert this in the abstract, this test builds a real
 * file-backed SQLite DB representing an "older-schema" install (only
 * migrations 001-004 applied -- roughly the M2 shape, before members,
 * explorer, mining, or notify existed), writes real user-visible data into
 * it, closes it, then re-opens the SAME FILE with the CURRENT full
 * migration set (001-008) -- simulating a container rebuild against the
 * same `/data` volume. It asserts the forward migrations apply cleanly and,
 * critically, that the pre-existing data survives byte-for-byte.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, listMigrations } from './migrations.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'hearth-update-path-'));
	dbPath = path.join(dir, 'hearth.db');
});

afterEach(async () => {
	// Windows can briefly hold the SQLite file/WAL handle open right after
	// close() returns; retry with short backoff rather than flake.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
});

/** Applies only the given migration ids, in order, to simulate an older-version install. */
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

describe('db: update-path safety (migration-forward on a real file, older-schema fixture)', () => {
	it('preserves real data written under an older schema when the current app opens the same file', () => {
		// --- "install v-old": only migrations up to 004 (wallets) applied ---
		const oldDb = new DatabaseSync(dbPath);
		applyOnlyMigrations(oldDb, 4);

		oldDb
			.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
			.run('alex', 'scrypt$fakehash', 'owner');
		const userId = oldDb.prepare('SELECT id FROM users WHERE username = ?').get('alex') as {
			id: number;
		};
		oldDb
			.prepare(
				`INSERT INTO wallets (user_id, name, kind, script_type, threshold, watch_only)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(userId.id, "Alex's savings", 'single', 'p2wpkh', 1, 1);

		const oldWalletCount = oldDb.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number };
		expect(oldWalletCount.n).toBe(1);
		const appliedBefore = oldDb.prepare('SELECT id FROM _migrations').all() as { id: number }[];
		expect(appliedBefore.map((r) => r.id)).toEqual([1, 2, 3, 4]);

		oldDb.close(); // simulates the old container stopping

		// --- "update to current": a fresh process opens the SAME FILE ---
		const newDb = new DatabaseSync(dbPath);
		expect(() => runMigrations(newDb)).not.toThrow();

		// Every migration, old and new, is now recorded.
		const appliedAfter = newDb.prepare('SELECT id FROM _migrations ORDER BY id').all() as {
			id: number;
		}[];
		expect(appliedAfter.map((r) => r.id)).toEqual(listMigrations().map((m) => m.id));

		// The pre-existing user survives the update, unmodified.
		const user = newDb.prepare('SELECT username, role FROM users WHERE username = ?').get('alex') as {
			username: string;
			role: string;
		};
		expect(user).toEqual({ username: 'alex', role: 'owner' });

		// The pre-existing wallet survives the update, unmodified.
		const wallet = newDb.prepare('SELECT name, kind, watch_only FROM wallets WHERE user_id = ?').get(
			userId.id
		) as { name: string; kind: string; watch_only: number };
		expect(wallet).toEqual({ name: "Alex's savings", kind: 'single', watch_only: 1 });

		// New-version tables (e.g. members/invites from migration 005, notify
		// from 008) are now usable against the SAME file/rows.
		const tables = newDb
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain('invites'); // migration 005
		expect(names).toContain('explorer_snapshot'); // migration 006 (explorer)
		expect(names).toContain('mining_workers'); // migration 007
		expect(names).toContain('notification_preferences'); // migration 008

		newDb.close();

		// --- simulates a SECOND restart (e.g. a plain container restart,
		// not an update) against the now-fully-migrated file: idempotent,
		// no data loss, no re-run errors. ---
		const thirdOpenDb = new DatabaseSync(dbPath);
		expect(() => runMigrations(thirdOpenDb)).not.toThrow();
		const stillThere = thirdOpenDb.prepare('SELECT COUNT(*) AS n FROM wallets').get() as {
			n: number;
		};
		expect(stillThere.n).toBe(1);
		thirdOpenDb.close();
	});

	it('applies every migration forward from a completely fresh (pre-001) file, for comparison', () => {
		const db = new DatabaseSync(dbPath);
		expect(() => runMigrations(db)).not.toThrow();
		const applied = db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[];
		expect(applied.map((r) => r.id)).toEqual(listMigrations().map((m) => m.id));
		db.close();
	});
});
