/**
 * T0 acceptance (COME-ABOARD.md §8): migration 005 is idempotent and adds
 * exactly the columns §1.1 specifies; the household greeting helper falls
 * back sanely when unset.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations, listMigrations } from '../index.js';
import { householdGreetingName, setHouseholdName, hasBeenWelcomed, markWelcomed } from '../../auth/household.js';

function columns(db: DatabaseSync, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('migration 005: invites + members columns', () => {
	it('adds the invite provenance + member-management columns', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);

		const inviteCols = columns(db, 'invites');
		expect(inviteCols).toContain('note');
		expect(inviteCols).toContain('accepted_at');

		const userCols = columns(db, 'users');
		expect(userCols).toContain('display_name');
		expect(userCols).toContain('invited_by');
		expect(userCols).toContain('created_via_invite');
		expect(userCols).toContain('last_active_at');
	});

	it('is idempotent and registers as migration id 5', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		const applied = db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[];
		expect(applied.map((a) => a.id)).toContain(5);
		expect(applied.length).toBe(listMigrations().length);
	});
});

describe('household greeting helper', () => {
	beforeEach(() => {
		closeDb();
		const db = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
	});

	it('falls back to "your host" when there is no owner and no meta set yet', () => {
		expect(householdGreetingName()).toBe('your host');
	});

	it('falls back to the first Owner display_name/username when meta is unset', () => {
		getDb()
			.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
			.run('alex', 'h', 'owner', 'Alex M');
		expect(householdGreetingName()).toBe('Alex M');
	});

	it('prefers an explicit household.name over the owner fallback', () => {
		setHouseholdName('The Martinez House');
		expect(householdGreetingName()).toBe('The Martinez House');
	});

	it('tracks the per-user welcomed flag independently per user', () => {
		expect(hasBeenWelcomed(1)).toBe(false);
		markWelcomed(1);
		expect(hasBeenWelcomed(1)).toBe(true);
		expect(hasBeenWelcomed(2)).toBe(false);
	});
});
