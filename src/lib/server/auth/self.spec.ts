/**
 * T12 acceptance (COME-ABOARD.md §3.2, §8): self profile/prefs -- a Member/
 * Guest can change their own display name and password (with current-
 * password verification), and a minimal theme pref round-trips.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '../db/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, getSessionUser } from './session.js';
import { updateOwnProfile, getOwnPrefs, setOwnTheme } from './self.js';
import { AuthError } from './users.js';

let userId: number;
const ORIGINAL_PASSWORD = 'the original passphrase';

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	const hash = await hashPassword(ORIGINAL_PASSWORD);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mum', hash, 'member');
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

describe('T12: updateOwnProfile', () => {
	it('updates display name alone, leaving the password untouched', async () => {
		await updateOwnProfile(userId, { displayName: 'Mum' });
		const row = getDb().prepare('SELECT display_name, password_hash FROM users WHERE id = ?').get(userId) as {
			display_name: string;
			password_hash: string;
		};
		expect(row.display_name).toBe('Mum');
		expect(await verifyPassword(ORIGINAL_PASSWORD, row.password_hash)).toBe(true);
	});

	it('changes the password when the current password is correct', async () => {
		await updateOwnProfile(userId, { currentPassword: ORIGINAL_PASSWORD, newPassword: 'a brand new passphrase' });
		const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as {
			password_hash: string;
		};
		expect(await verifyPassword('a brand new passphrase', row.password_hash)).toBe(true);
		expect(await verifyPassword(ORIGINAL_PASSWORD, row.password_hash)).toBe(false);
	});

	it('rejects a password change with the wrong current password', async () => {
		await expect(
			updateOwnProfile(userId, { currentPassword: 'nope', newPassword: 'a brand new passphrase' })
		).rejects.toThrow(AuthError);
	});

	it('rejects a too-short new password', async () => {
		await expect(
			updateOwnProfile(userId, { currentPassword: ORIGINAL_PASSWORD, newPassword: 'short' })
		).rejects.toMatchObject({ code: 'weak_password' });
	});

	it('clearing displayName (empty string) resets it to null (falls back to username)', async () => {
		await updateOwnProfile(userId, { displayName: 'Mum' });
		await updateOwnProfile(userId, { displayName: '' });
		const row = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as {
			display_name: string | null;
		};
		expect(row.display_name).toBeNull();
	});

	it('a display-name-only update does not touch sessions', async () => {
		const { token } = createSession(userId);
		const result = await updateOwnProfile(userId, { displayName: 'Mum' });
		expect(result.newSession).toBeNull();
		expect(getSessionUser(token)).not.toBeNull();
	});

	it('a password change destroys every OTHER session but hands back a fresh one for the caller', async () => {
		const other = createSession(userId);
		expect(getSessionUser(other.token)).not.toBeNull();

		const result = await updateOwnProfile(userId, {
			currentPassword: ORIGINAL_PASSWORD,
			newPassword: 'a brand new passphrase'
		});

		// The pre-existing session is gone...
		expect(getSessionUser(other.token)).toBeNull();
		// ...but the caller gets a working replacement.
		expect(result.newSession).not.toBeNull();
		expect(getSessionUser(result.newSession!.token)).not.toBeNull();
		expect(getSessionUser(result.newSession!.token)!.id).toBe(userId);
	});
});

describe('T12: theme prefs', () => {
	it('defaults to system when unset', () => {
		expect(getOwnPrefs(userId).theme).toBe('system');
	});

	it('round-trips a chosen theme', () => {
		setOwnTheme(userId, 'dark');
		expect(getOwnPrefs(userId).theme).toBe('dark');
	});
});
