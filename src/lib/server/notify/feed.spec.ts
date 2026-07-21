/**
 * T3 acceptance (WATCHTOWER.md §4.2, §6.7 feed.scope.test.ts): a Member's
 * feed never leaks another member's financial rows; the Owner sees all
 * (read-only cross-member view); a Guest sees only non-financial system rows.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { dispatch } from './dispatch.js';
import { listFeed } from './feed.js';

let alice: number;
let bob: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('alice', 'x', 'owner')`).run();
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('bob', 'x', 'member')`).run();
	const rows = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
	alice = rows.find((r) => r.username === 'alice')!.id;
	bob = rows.find((r) => r.username === 'bob')!.id;

	// Alice's own financial event.
	dispatch({ type: 'tx_received', userId: alice, level: 'success', title: 'a', body: 'a-body' });
	// Bob's own financial event.
	dispatch({ type: 'tx_received', userId: bob, level: 'success', title: 'b', body: 'b-body' });
	// A broadcast/system event -- mirrors mining's pre-existing notify() shape
	// (notify/index.ts): user_id NULL, a non-financial type string (mining/
	// node-health events are written that way, not through dispatch()).
	// Inserted directly since dispatch()'s payload.type is typed to the
	// watchtower's own narrow NotificationEventType union.
	getDb()
		.prepare(`INSERT INTO events (type, user_id, level, title, body) VALUES ('mining_block_found', NULL, 'info', 'sys', 'sys-body')`)
		.run();
});

describe('T3: feed.ts -- per-role scoping (WATCHTOWER.md §4.2)', () => {
	it('the Owner sees EVERY row (the household feed, read-only)', () => {
		const rows = listFeed('owner', alice);
		expect(rows.length).toBe(3);
	});

	it("a Member sees their OWN financial rows, never another member's", () => {
		const rows = listFeed('member', bob);
		expect(rows.some((r) => r.title === 'b')).toBe(true);
		expect(rows.some((r) => r.title === 'a')).toBe(false); // alice's own row -- never leaked
	});

	it('a Member ALSO sees non-financial broadcast/system rows', () => {
		const rows = listFeed('member', bob);
		expect(rows.some((r) => r.title === 'sys')).toBe(true);
	});

	it('a Guest sees ONLY non-financial broadcast/system rows -- no wallet events at all', () => {
		const rows = listFeed('guest', 999);
		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe('sys');
	});

	it('respects the limit parameter, newest first', () => {
		for (let i = 0; i < 5; i++) {
			dispatch({ type: 'tx_received', userId: alice, level: 'info', title: `extra-${i}`, body: 'x' });
		}
		const rows = listFeed('owner', alice, 3);
		expect(rows.length).toBe(3);
		expect(rows[0].title).toBe('extra-4'); // newest first
	});

	it('detail JSON round-trips (including the folded-in link)', () => {
		dispatch({
			type: 'tx_received',
			userId: alice,
			level: 'info',
			title: 'with-detail',
			body: 'x',
			detail: { amountSats: 500 },
			link: '/wallets/2'
		});
		const rows = listFeed('owner', alice);
		const row = rows.find((r) => r.title === 'with-detail')!;
		expect(row.detail).toEqual({ amountSats: 500, link: '/wallets/2' });
	});
});
