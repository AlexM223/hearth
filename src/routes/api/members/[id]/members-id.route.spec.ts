/**
 * T11 acceptance (COME-ABOARD.md §7.1, §7.5, §8): the real PATCH/DELETE
 * handlers, gated owner-only; last-Owner guard surfaces as 409.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { PATCH, DELETE } from './+server.js';

let ownerId: number;
let memberId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'owner' | 'member' | 'guest' | null, params: Record<string, string>, body?: unknown): any {
	return {
		locals: { user: role == null ? null : { id: ownerId, username: role, role, mustResetPassword: false } },
		params,
		request: { json: async () => body }
	};
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		if (res instanceof Response) {
			expect(res.status).toBe(status);
			return await res.json();
		}
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		const err = e as { status?: number; body?: unknown };
		expect(err.status).toBe(status);
		return err.body;
	}
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	ownerId = Number((db.prepare("SELECT id FROM users WHERE username='owner'").get() as { id: number }).id);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mum', 'h2', 'member');
	memberId = Number((db.prepare("SELECT id FROM users WHERE username='mum'").get() as { id: number }).id);
});

describe('T11: PATCH /api/members/:id (role change)', () => {
	it('owner can promote a member to guest', async () => {
		await expectStatus(() => PATCH(evt('owner', { id: String(memberId) }, { role: 'guest' })), 200);
		const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(memberId) as { role: string };
		expect(row.role).toBe('guest');
	});

	it('demoting the sole Owner is 409 (last-Owner guard)', async () => {
		await expectStatus(() => PATCH(evt('owner', { id: String(ownerId) }, { role: 'member' })), 409);
	});

	it('member/guest/anon are denied', async () => {
		await expectStatus(() => PATCH({ ...evt('member', { id: String(memberId) }, { role: 'guest' }) }), 403);
		await expectStatus(() => PATCH(evt(null, { id: String(memberId) }, { role: 'guest' })), 401);
	});

	it('an unknown target is 404', async () => {
		await expectStatus(() => PATCH(evt('owner', { id: '999999' }, { role: 'guest' })), 404);
	});
});

describe('T11: DELETE /api/members/:id (offboard)', () => {
	it('owner offboards a member (default remove policy)', async () => {
		const body = (await expectStatus(() => DELETE(evt('owner', { id: String(memberId) }, {})), 200)) as {
			offboarded: boolean;
			walletPolicy: string;
		};
		expect(body.offboarded).toBe(true);
		expect(body.walletPolicy).toBe('remove');
		expect(getDb().prepare('SELECT id FROM users WHERE id = ?').get(memberId)).toBeUndefined();
	});

	it('owner offboards with transfer policy', async () => {
		const body = (await expectStatus(
			() => DELETE(evt('owner', { id: String(memberId) }, { walletPolicy: 'transfer' })),
			200
		)) as { walletPolicy: string };
		expect(body.walletPolicy).toBe('transfer');
	});

	it('offboarding the sole Owner is 409', async () => {
		await expectStatus(() => DELETE(evt('owner', { id: String(ownerId) }, {})), 409);
	});

	it('member/guest/anon cannot offboard', async () => {
		await expectStatus(() => DELETE(evt('member', { id: String(memberId) }, {})), 403);
		await expectStatus(() => DELETE(evt(null, { id: String(memberId) }, {})), 401);
	});
});
