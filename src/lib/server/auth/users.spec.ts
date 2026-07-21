import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createSession, getSessionUser } from './session.js';
import {
	AuthError,
	bootstrapAdminFromEnv,
	completeForcedCredentialReset,
	loginWithPassword,
	mustResetPassword,
	userCount
} from './users.js';

beforeEach(() => {
	const db = openDb(':memory:');
	runMigrations(db);
});

afterEach(() => {
	closeDb();
});

describe('auth: first-run admin bootstrap (DECISIONS.md §4.3)', () => {
	it('does nothing when HEARTH_ADMIN_PASSWORD is unset', async () => {
		await bootstrapAdminFromEnv({});
		expect(userCount()).toBe(0);
	});

	it('does nothing when the password is shorter than the minimum', async () => {
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'short' });
		expect(userCount()).toBe(0);
	});

	it('creates the first Owner, flagged must_reset_password', async () => {
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'install-password-123' });
		expect(userCount()).toBe(1);

		const user = await loginWithPassword('admin', 'install-password-123');
		expect(user.role).toBe('owner');
		expect(mustResetPassword(user.id)).toBe(true);
	});

	it('is idempotent -- never re-creates or duplicates the admin on a second boot', async () => {
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'install-password-123' });
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'a-different-password-456' });
		expect(userCount()).toBe(1);
		// Still logs in with the FIRST password -- a restart must never silently
		// reset a human-chosen password back to the env var.
		await expect(loginWithPassword('admin', 'install-password-123')).resolves.toBeTruthy();
	});
});

describe('auth: password login', () => {
	beforeEach(async () => {
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'install-password-123' });
	});

	it('logs in with correct credentials', async () => {
		const user = await loginWithPassword('admin', 'install-password-123');
		expect(user.username).toBe('admin');
	});

	it('throws the SAME error for an unknown username and a wrong password', async () => {
		let unknownErr: unknown;
		let wrongErr: unknown;
		try {
			await loginWithPassword('nobody', 'whatever');
		} catch (e) {
			unknownErr = e;
		}
		try {
			await loginWithPassword('admin', 'wrong-password');
		} catch (e) {
			wrongErr = e;
		}
		expect(unknownErr).toBeInstanceOf(AuthError);
		expect(wrongErr).toBeInstanceOf(AuthError);
		expect((unknownErr as AuthError).message).toBe((wrongErr as AuthError).message);
		expect((unknownErr as AuthError).code).toBe('bad_credentials');
	});

	it('is case-insensitive on username', async () => {
		const user = await loginWithPassword('ADMIN', 'install-password-123');
		expect(user.username).toBe('admin');
	});
});

describe('auth: forced credential reset', () => {
	let adminId: number;

	beforeEach(async () => {
		await bootstrapAdminFromEnv({ HEARTH_ADMIN_PASSWORD: 'install-password-123' });
		const user = await loginWithPassword('admin', 'install-password-123');
		adminId = user.id;
	});

	it('sets a new username + password and clears must_reset_password', async () => {
		await completeForcedCredentialReset(adminId, { username: 'alex', password: 'a-real-password-1' });
		expect(mustResetPassword(adminId)).toBe(false);
		const user = await loginWithPassword('alex', 'a-real-password-1');
		expect(user.id).toBe(adminId);
	});

	it('refuses to reuse the install password', async () => {
		await expect(
			completeForcedCredentialReset(
				adminId,
				{ username: 'alex', password: 'install-password-123' },
				{ HEARTH_ADMIN_PASSWORD: 'install-password-123' }
			)
		).rejects.toThrow(AuthError);
	});

	it('refuses a taken username', async () => {
		getDb()
			.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
			.run('taken', 'scrypt:16384:8:1:salt:hash', 'member');
		await expect(
			completeForcedCredentialReset(adminId, { username: 'taken', password: 'a-real-password-1' })
		).rejects.toThrow(AuthError);
	});

	it('refuses a weak password', async () => {
		await expect(
			completeForcedCredentialReset(adminId, { username: 'alex', password: 'short' })
		).rejects.toThrow(AuthError);
	});

	it('revokes every existing session for the user (the install password was visible in the setup UI)', async () => {
		const { token } = createSession(adminId);
		expect(getSessionUser(token)).not.toBeNull();

		await completeForcedCredentialReset(adminId, { username: 'alex', password: 'a-real-password-1' });

		expect(getSessionUser(token)).toBeNull();
	});
});
