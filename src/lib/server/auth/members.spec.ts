/**
 * T10 acceptance (COME-ABOARD.md §4, §8): the Owner-sees-all roster and
 * household summary. Never leaks a credential column; balance comes ONLY
 * from the caller-supplied wallet-balance reader (dependency-injected so
 * this module cannot reach into wallets/addresses/psbt_drafts directly).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '../db/index.js';
import { listMembers, householdSummary, activityBucket, type WalletBalanceReader } from './members.js';

let ownerId: number;
let memberId: number;
let guestId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)').run(
		'alex',
		'sekret-hash',
		'owner',
		'Alex'
	);
	ownerId = Number((db.prepare("SELECT id FROM users WHERE username='alex'").get() as { id: number }).id);
	db.prepare('INSERT INTO users (username, password_hash, role, invited_by) VALUES (?, ?, ?, ?)').run(
		'mum',
		'h2',
		'member',
		ownerId
	);
	memberId = Number((db.prepare("SELECT id FROM users WHERE username='mum'").get() as { id: number }).id);
	db.prepare('INSERT INTO users (username, password_hash, role, invited_by) VALUES (?, ?, ?, ?)').run(
		'friend',
		'h3',
		'guest',
		ownerId
	);
	guestId = Number((db.prepare("SELECT id FROM users WHERE username='friend'").get() as { id: number }).id);
});

const noBalances: WalletBalanceReader = () => [];

describe('T10: listMembers -- roster shape', () => {
	it('lists every user with role/displayName/invitedBy, never a credential', () => {
		const rows = listMembers(noBalances);
		expect(rows.length).toBe(3);
		const raw = JSON.stringify(rows);
		expect(raw).not.toContain('sekret-hash');
		expect(raw).not.toContain('password');

		const mum = rows.find((r) => r.username === 'mum')!;
		expect(mum.role).toBe('member');
		expect(mum.invitedByUsername).toBe('alex');
		expect(mum.displayName).toBeNull();
	});

	it('sums balances from the injected reader, never reading wallets/psbt_drafts itself', () => {
		const reader: WalletBalanceReader = (userId) =>
			userId === memberId ? [{ confirmedSats: 100_000, unconfirmedSats: 500 }] : [];
		const rows = listMembers(reader);
		const mum = rows.find((r) => r.username === 'mum')!;
		expect(mum.confirmedSats).toBe(100_000);
		expect(mum.unconfirmedSats).toBe(500);
		expect(mum.walletCount).toBe(1);

		const friend = rows.find((r) => r.username === 'friend')!;
		expect(friend.confirmedSats).toBe(0);
		expect(friend.walletCount).toBe(0);
	});

	it('never includes a psbt/draft/address field on any row (structural: check the key set)', () => {
		const rows = listMembers(noBalances);
		for (const row of rows) {
			const keys = Object.keys(row);
			expect(keys).not.toContain('psbt');
			expect(keys).not.toContain('address');
			expect(keys).not.toContain('passwordHash');
		}
	});
});

describe('T10: householdSummary', () => {
	it('memberCount never counts the Owner; confirmedSats includes everyone', () => {
		const reader: WalletBalanceReader = (userId) => {
			if (userId === ownerId) return [{ confirmedSats: 10_000, unconfirmedSats: 0 }];
			if (userId === memberId) return [{ confirmedSats: 5_000, unconfirmedSats: 0 }];
			return [];
		};
		const summary = householdSummary(reader);
		expect(summary.memberCount).toBe(2); // mum + friend, not alex
		expect(summary.confirmedSats).toBe(15_000); // owner + member, household-wide
	});
});

describe('T10: activityBucket (coarsened liveness, never an exact timestamp)', () => {
	const NOW = Date.parse('2026-07-21T12:00:00.000Z');

	it('never -> null last_active_at', () => {
		expect(activityBucket(null, NOW)).toBe('never');
	});

	it('active recently -> within 24h', () => {
		expect(activityBucket(new Date(NOW - 60_000).toISOString(), NOW)).toBe('active recently');
	});

	it('this week -> 2-7 days ago', () => {
		expect(activityBucket(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('this week');
	});

	it('dormant -> more than 7 days ago', () => {
		expect(activityBucket(new Date(NOW - 30 * 86_400_000).toISOString(), NOW)).toBe('dormant');
	});
});
