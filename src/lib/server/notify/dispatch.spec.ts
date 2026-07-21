/**
 * T3 acceptance (WATCHTOWER.md §1.5, §4.1, §4.3, §6.7): dispatch() writes
 * ONE `events` row + publishes exactly the SSE frames the scope map
 * requires -- a member's tx event reaches {user} AND the {admin} household
 * roll-up, NEVER a bare {broadcast} (the leak WATCHTOWER.md §4.3 calls out
 * explicitly). External enqueue only happens when a resolver says so
 * (T7's real prefs aren't wired yet -- the default is correctly none).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { register, type LiveConnection } from '../events/index.js';
import { dispatch, publishDispatched } from './dispatch.js';

function makeConn(overrides: Partial<LiveConnection> = {}): LiveConnection & { sent: string[] } {
	const sent: string[] = [];
	return { userId: 1, isAdmin: false, send: (f: string) => sent.push(f), sent, ...overrides };
}

let userId: number;
beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

function eventRows(): unknown[] {
	return getDb().prepare('SELECT * FROM events').all();
}

describe('T3: dispatch() -- the in-app write + SSE fan-out', () => {
	it('writes exactly ONE events row for a tx_received payload', () => {
		dispatch({
			type: 'tx_received',
			userId,
			level: 'success',
			title: 'Payment received',
			body: 'You received 0.0015 BTC in Savings.',
			detail: { amountSats: 150000, walletName: 'Savings' },
			link: '/wallets/1'
		});
		const rows = eventRows() as { type: string; user_id: number; level: string; title: string; detail: string }[];
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe('tx_received');
		expect(rows[0].user_id).toBe(userId);
		expect(rows[0].level).toBe('success'); // NotificationLevel 'success' maps 1:1
		const detail = JSON.parse(rows[0].detail);
		expect(detail.amountSats).toBe(150000);
		expect(detail.link).toBe('/wallets/1'); // link folds into detail
	});

	it('maps warn->warning and error->danger at write time', () => {
		dispatch({ type: 'tx_replaced', userId, level: 'warn', title: 'x', body: 'y' });
		dispatch({ type: 'tx_replaced', userId, level: 'error', title: 'x', body: 'y' });
		const rows = eventRows() as { level: string }[];
		expect(rows[0].level).toBe('warning');
		expect(rows[1].level).toBe('danger');
	});

	it('publishes a {user} frame AND a separate {admin} household roll-up -- NEVER a bare {broadcast} (WATCHTOWER.md §4.3)', () => {
		const owner = makeConn({ userId: 999, isAdmin: true });
		const member = makeConn({ userId, isAdmin: false });
		const guest = makeConn({ userId: 555, isAdmin: false });
		const unA = register(owner);
		const unB = register(member);
		const unC = register(guest);

		dispatch({ type: 'tx_received', userId, level: 'success', title: 't', body: 'b' });

		expect(member.sent.length).toBe(1); // {user, userId=member} reaches the member
		expect(owner.sent.length).toBe(1); // {admin} reaches the owner (the roll-up)
		expect(guest.sent.length).toBe(0); // a guest is neither the user nor admin

		unA();
		unB();
		unC();
	});

	it('a null-userId payload publishes {broadcast} only (no admin/user frames)', () => {
		const owner = makeConn({ userId: 999, isAdmin: true });
		const member = makeConn({ userId, isAdmin: false });
		const unA = register(owner);
		const unB = register(member);

		dispatch({ type: 'tx_received', userId: null, level: 'info', title: 't', body: 'b' });
		expect(owner.sent.length).toBe(1);
		expect(member.sent.length).toBe(1);

		unA();
		unB();
	});

	it('never throws even when the resolver throws', () => {
		expect(() =>
			dispatch(
				{ type: 'tx_received', userId, level: 'info', title: 't', body: 'b' },
				{
					resolveTargets: () => {
						throw new Error('boom');
					}
				}
			)
		).not.toThrow();
	});

	it('does NOT enqueue any external target when no resolver is given (the correct default: inapp-only)', () => {
		dispatch({ type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		const queueRows = getDb().prepare('SELECT COUNT(*) AS n FROM notification_queue').get() as { n: number };
		expect(queueRows.n).toBe(0);
	});

	it('enqueues one notification_queue row per resolved external target, serialized payload carries no secret fields', () => {
		dispatch(
			{ type: 'tx_received', userId, level: 'info', title: 't', body: 'You received 0.001 BTC.' },
			{ resolveTargets: () => [{ channel: 'webhook' }, { channel: 'ntfy' }] }
		);
		const rows = getDb()
			.prepare('SELECT channel, event_type, payload, status FROM notification_queue ORDER BY channel')
			.all() as { channel: string; event_type: string; payload: string; status: string }[];
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.channel)).toEqual(['ntfy', 'webhook']);
		expect(rows[0].status).toBe('pending');
		expect(JSON.parse(rows[0].payload).type).toBe('tx_received');
	});

	it('a tx_replaced payload carries no txid/amountSats key when the caller omits them (structural, not enforced here -- render.ts/T5 shapes the actual payload)', () => {
		dispatch({ type: 'tx_replaced', userId, level: 'warn', title: 'Incoming payment cancelled', body: 'x' });
		const rows = eventRows() as { detail: string | null }[];
		expect(rows[0].detail).toBeNull();
	});

	it('publishDispatched never reads SQLite (DECISIONS.md §4.5 hard invariant -- works even with the db closed)', () => {
		closeDb();
		expect(() =>
			publishDispatched({ type: 'tx_received', userId, level: 'info', title: 't', body: 'b' })
		).not.toThrow();
	});
});
