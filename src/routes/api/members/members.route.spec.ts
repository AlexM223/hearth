/**
 * T10 acceptance (COME-ABOARD.md §7.1, §8): GET /api/members is Owner-only;
 * the response never leaks a psbt/address/credential field.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { GET } from './+server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'owner' | 'member' | 'guest' | null): any {
	return { locals: { user: role == null ? null : { id: 1, username: role, role, mustResetPassword: false } } };
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
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'secret-hash', 'owner');
});

describe('T10: GET /api/members route gate', () => {
	it('owner -> 200 with the roster, no credential leak', async () => {
		const body = (await expectStatus(() => GET(evt('owner')), 200)) as { members: unknown[] };
		expect(body.members.length).toBe(1);
		expect(JSON.stringify(body)).not.toContain('secret-hash');
	});

	it('member/guest/anon are denied', async () => {
		await expectStatus(() => GET(evt('member')), 403);
		await expectStatus(() => GET(evt('guest')), 403);
		await expectStatus(() => GET(evt(null)), 401);
	});
});
