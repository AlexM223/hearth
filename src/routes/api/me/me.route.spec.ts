/**
 * T12 acceptance (COME-ABOARD.md §3.2, §7.1, §8): /api/me/** is reachable by
 * any authenticated role (self-scoped), never by an anonymous caller.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { hashPassword } from '$lib/server/auth/password.js';
import { POST as postProfile } from './profile/+server.js';
import { GET as getPrefs, POST as postPrefs } from './prefs/+server.js';

let memberId: number;
const PASSWORD = 'a decent starter password';

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	const hash = await hashPassword(PASSWORD);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mum', hash, 'member');
	memberId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'member' | 'guest' | null, body?: unknown): any {
	return {
		locals: { user: role == null ? null : { id: memberId, username: 'mum', role, mustResetPassword: false } },
		request: { json: async () => body },
		// A password change reissues the session cookie (T12/hearth-ja1) --
		// the profile route needs these even though most other requests don't.
		cookies: { set: () => {}, get: () => undefined, delete: () => {} },
		url: new URL('http://localhost/api/me/profile')
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

describe('T12: POST /api/me/profile', () => {
	it('a Member can update their own display name', async () => {
		await expectStatus(() => postProfile(evt('member', { displayName: 'Mum' })), 200);
		const row = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(memberId) as {
			display_name: string;
		};
		expect(row.display_name).toBe('Mum');
	});

	it('a Guest can also reach their own profile (least privilege, but still self-scoped)', async () => {
		await expectStatus(() => postProfile(evt('guest', { displayName: 'Friend' })), 200);
	});

	it('an anonymous caller is rejected', async () => {
		await expectStatus(() => postProfile(evt(null, { displayName: 'x' })), 401);
	});

	it('a wrong current password on a password-change attempt is a 400', async () => {
		await expectStatus(
			() => postProfile(evt('member', { currentPassword: 'nope', newPassword: 'a new long password' })),
			400
		);
	});

	it('a correct current password changes the password', async () => {
		await expectStatus(
			() => postProfile(evt('member', { currentPassword: PASSWORD, newPassword: 'a fresh new password' })),
			200
		);
	});
});

describe('T12: GET/POST /api/me/prefs', () => {
	it('defaults to system theme and round-trips a change', async () => {
		const initial = (await expectStatus(() => getPrefs(evt('member')), 200)) as { theme: string };
		expect(initial.theme).toBe('system');

		await expectStatus(() => postPrefs(evt('member', { theme: 'dark' })), 200);
		const after = (await expectStatus(() => getPrefs(evt('member')), 200)) as { theme: string };
		expect(after.theme).toBe('dark');
	});

	it('rejects a garbage theme value', async () => {
		await expectStatus(() => postPrefs(evt('member', { theme: 'purple' })), 400);
	});

	it('anon is rejected on both GET and POST', async () => {
		await expectStatus(() => getPrefs(evt(null)), 401);
		await expectStatus(() => postPrefs(evt(null, { theme: 'dark' })), 401);
	});
});
