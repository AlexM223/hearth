/**
 * Self-service profile/prefs (COME-ABOARD.md §3.2's carve-out: a Member/Guest
 * cannot reach instance Settings, but must still be able to change their OWN
 * password and display name -- so "no Settings for non-Owners" never traps
 * a member out of their own password). `/api/me/**`, gated `authed`+self-scope.
 */
import { getDb, withTransaction, getMeta, setMeta } from '../db/index.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { createSession, destroyUserSessions } from './session.js';
import { AuthError } from './users.js';

export interface UpdateProfileInput {
	/** undefined = leave unchanged; '' / null clears it back to the username default. */
	displayName?: string | null;
	/** Both required together to change the password; omit both to skip. */
	currentPassword?: string;
	newPassword?: string;
}

export interface UpdateProfileResult {
	/** Set only when the password changed. Every OTHER session for this user
	 *  was just destroyed (a leaked/left-open session must not survive a
	 *  password change), including the one the caller made this request with
	 *  -- so a fresh one is minted here for the caller to re-issue as their
	 *  cookie. Mirrors completeForcedCredentialReset's rotate-then-reissue
	 *  pattern in users.ts. */
	newSession: { token: string; expiresAt: Date } | null;
}

/** Update the caller's own display name and/or password. A password change
 *  requires the current password (defense against a hijacked/left-open
 *  session); hashing happens BEFORE the transaction (async, off the tx path).
 *  A password change also rotates sessions -- see UpdateProfileResult. */
export async function updateOwnProfile(userId: number, input: UpdateProfileInput): Promise<UpdateProfileResult> {
	const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
		| { password_hash: string }
		| undefined;
	if (!row) throw new AuthError('User not found.', 'not_found');

	let newHash: string | null = null;
	if (input.newPassword != null || input.currentPassword != null) {
		if (!input.currentPassword || !(await verifyPassword(input.currentPassword, row.password_hash))) {
			throw new AuthError('Current password is incorrect.', 'bad_current_password');
		}
		if (!input.newPassword || input.newPassword.length < MIN_PASSWORD_LENGTH) {
			throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'weak_password');
		}
		newHash = await hashPassword(input.newPassword);
	}

	withTransaction((db) => {
		if (input.displayName !== undefined) {
			db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
				input.displayName?.trim() || null,
				userId
			);
		}
		if (newHash) {
			db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
		}
	});

	if (!newHash) return { newSession: null };

	// The old password may have been shared with (or guessed by) whoever holds
	// another session -- destroy every session for this user, then mint a
	// fresh one so the caller's own login survives the rotation.
	destroyUserSessions(userId);
	const { token, expiresAt } = createSession(userId);
	return { newSession: { token, expiresAt } };
}

export interface OwnPrefs {
	theme: 'system' | 'dark' | 'light';
}

/** Minimal server-persisted prefs (theme). Notification-channel prefs are
 *  M6's `notify` module scope -- this seam exists now so `/api/me/prefs` has
 *  somewhere real to read/write today rather than being a stub. */
export function getOwnPrefs(userId: number): OwnPrefs {
	const theme = getMeta(`prefs.theme.${userId}`);
	return { theme: theme === 'dark' || theme === 'light' ? theme : 'system' };
}

export function setOwnTheme(userId: number, theme: 'system' | 'dark' | 'light'): void {
	setMeta(`prefs.theme.${userId}`, theme);
}
