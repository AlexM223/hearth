/**
 * T12 acceptance (COME-ABOARD.md §3.6, §7.1, §8): Owner always sees the
 * household aggregate; a Guest only when opted in; response is aggregate
 * only (no per-member breakdown key).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { setGuestSeesHouseholdBalance } from '$lib/server/auth/index.js';
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
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
});

describe('T12: GET /api/household/summary -- opt-in gate', () => {
	it('Owner always sees it, opt-in or not', async () => {
		const body = (await expectStatus(() => GET(evt('owner')), 200)) as Record<string, unknown>;
		expect(body).toHaveProperty('confirmedSats');
		expect(body).not.toHaveProperty('members'); // aggregate only
	});

	it('a Guest is denied (403) by default (opt-in is off)', async () => {
		await expectStatus(() => GET(evt('guest')), 403);
	});

	it('a Guest sees it once the Owner opts in', async () => {
		setGuestSeesHouseholdBalance(true);
		const body = (await expectStatus(() => GET(evt('guest')), 200)) as Record<string, unknown>;
		expect(body).toHaveProperty('confirmedSats');
	});

	it('anon is 401', async () => {
		await expectStatus(() => GET(evt(null)), 401);
	});
});
