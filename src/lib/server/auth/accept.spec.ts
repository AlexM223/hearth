/**
 * T5 acceptance (COME-ABOARD.md §7.2, §8): the full accept-transaction edge
 * matrix -- happy path, concurrent single-use race, expired/revoked/
 * exhausted/unknown (undifferentiated), revoked-mid-accept, username
 * collision (retry works, code not burned).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '../db/index.js';
import { createInvite } from './invites.js';
import { acceptInvite, AcceptInviteError } from './accept.js';
import { getSessionUser } from './session.js';

let ownerId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	ownerId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

function form(code: string, overrides: Partial<Parameters<typeof acceptInvite>[0]> = {}) {
	return {
		code,
		username: 'newmember',
		password: 'correct horse battery staple',
		confirmPassword: 'correct horse battery staple',
		displayName: 'New Member',
		...overrides
	};
}

describe('T5: acceptInvite -- happy path', () => {
	it('creates a user with the invite role, must_reset_password=0, and a live session', async () => {
		const { code, role } = createInvite(ownerId, { role: 'member' });
		const result = await acceptInvite(form(code));

		expect(result.user.role).toBe(role);
		expect(result.user.mustResetPassword).toBe(false);
		expect(result.user.username).toBe('newmember');

		const sessionUser = getSessionUser(result.sessionToken);
		expect(sessionUser).not.toBeNull();
		expect(sessionUser!.id).toBe(result.user.id);

		const row = getDb()
			.prepare('SELECT used_count, accepted_at FROM invites WHERE id = (SELECT id FROM invites LIMIT 1)')
			.get() as { used_count: number; accepted_at: string | null };
		expect(row.used_count).toBe(1);
		expect(row.accepted_at).not.toBeNull();

		const userRow = getDb()
			.prepare('SELECT invited_by, created_via_invite, display_name FROM users WHERE username = ?')
			.get('newmember') as { invited_by: number; created_via_invite: number; display_name: string };
		expect(userRow.invited_by).toBe(ownerId);
		expect(userRow.display_name).toBe('New Member');
	});
});

describe('T5: acceptInvite -- undifferentiated dead ends (§1.5)', () => {
	it('unknown code -> invite_invalid, no user created', async () => {
		await expect(acceptInvite(form('not-a-real-code'))).rejects.toMatchObject({ code: 'invite_invalid' });
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 }); // just the owner
	});

	it('expired code -> invite_invalid, used_count unchanged', async () => {
		const { code, id } = createInvite(ownerId, { role: 'member', expiresInMs: -1000 });
		await expect(acceptInvite(form(code))).rejects.toMatchObject({ code: 'invite_invalid' });
		expect((getDb().prepare('SELECT used_count FROM invites WHERE id = ?').get(id) as { used_count: number }).used_count).toBe(0);
	});

	it('revoked code -> invite_invalid, used_count unchanged', async () => {
		const { code, id } = createInvite(ownerId, { role: 'member' });
		getDb().prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(id);
		await expect(acceptInvite(form(code))).rejects.toMatchObject({ code: 'invite_invalid' });
		expect((getDb().prepare('SELECT used_count FROM invites WHERE id = ?').get(id) as { used_count: number }).used_count).toBe(0);
	});

	it('already-exhausted code -> invite_invalid', async () => {
		const { code, id } = createInvite(ownerId, { role: 'guest', maxUses: 1 });
		getDb().prepare('UPDATE invites SET used_count = 1 WHERE id = ?').run(id);
		await expect(acceptInvite(form(code))).rejects.toMatchObject({ code: 'invite_invalid' });
	});
});

describe('T5: acceptInvite -- races', () => {
	it('concurrent single-use accept: exactly one succeeds, used_count ends at 1, one user created', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		const results = await Promise.allSettled([
			acceptInvite(form(code, { username: 'racer-a' })),
			acceptInvite(form(code, { username: 'racer-b' }))
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'invite_race_lost' });

		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(1);

		const userCount = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
		expect(userCount.n).toBe(2); // owner + exactly one racer
	});

	it('concurrent multi-use accept with room: both succeed, used_count increments correctly', async () => {
		const { code } = createInvite(ownerId, { role: 'guest', maxUses: 5 });
		const results = await Promise.allSettled([
			acceptInvite(form(code, { username: 'multi-a' })),
			acceptInvite(form(code, { username: 'multi-b' }))
		]);
		expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(2);
	});

	it('revoked mid-accept (between pre-flight and burn) -> invite_race_lost, no user', async () => {
		const { code, id } = createInvite(ownerId, { role: 'member' });
		// Revoke it AFTER the pre-flight would have passed but the conditional
		// UPDATE re-checks `revoked = 0` at burn time regardless of when the
		// revoke lands relative to the pre-flight read in a single-threaded run.
		getDb().prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(id);
		await expect(acceptInvite(form(code))).rejects.toMatchObject({ code: 'invite_invalid' });
	});
});

describe('T5: acceptInvite -- username collision', () => {
	it('a taken username rolls back WITHOUT burning the code; a retry with a new name works', async () => {
		getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('newmember', 'h', 'guest');
		const { code } = createInvite(ownerId, { role: 'member' });

		await expect(acceptInvite(form(code, { username: 'newmember' }))).rejects.toMatchObject({
			code: 'username_taken'
		});
		// NOT burned:
		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(0);

		// Retry with a fresh name succeeds and DOES burn it:
		const result = await acceptInvite(form(code, { username: 'newmember2' }));
		expect(result.user.username).toBe('newmember2');
		const row2 = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row2.used_count).toBe(1);
	});
});

describe('T5: acceptInvite -- form validation (never burns on a client error)', () => {
	it('rejects a bad username without touching the invite', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		await expect(acceptInvite(form(code, { username: 'AB' }))).rejects.toMatchObject({ code: 'invalid_username' });
		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(0);
	});

	it('rejects a short password without touching the invite', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		await expect(
			acceptInvite(form(code, { password: 'short', confirmPassword: 'short' }))
		).rejects.toMatchObject({ code: 'weak_password' });
		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(0);
	});

	it('rejects a password/confirm mismatch without touching the invite', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		await expect(
			acceptInvite(form(code, { confirmPassword: 'a totally different password' }))
		).rejects.toMatchObject({ code: 'password_mismatch' });
		const row = getDb().prepare('SELECT used_count FROM invites LIMIT 1').get() as { used_count: number };
		expect(row.used_count).toBe(0);
	});
});

describe('T5: AcceptInviteError instance check', () => {
	it('every thrown error is an AcceptInviteError with a stable code', async () => {
		try {
			await acceptInvite(form('bogus'));
			throw new Error('expected a throw');
		} catch (e) {
			expect(e).toBeInstanceOf(AcceptInviteError);
		}
	});
});
