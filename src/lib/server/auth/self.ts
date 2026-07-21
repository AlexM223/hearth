/**
 * Self-service profile/prefs (COME-ABOARD.md §3.2's carve-out: a Member/Guest
 * cannot reach instance Settings, but must still be able to change their OWN
 * password and display name -- so "no Settings for non-Owners" never traps
 * a member out of their own password). `/api/me/**`, gated `authed`+self-scope.
 */
import { getDb, withTransaction } from '../db/index.js';
import { getMeta, setMeta } from '../db/meta.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { AuthError } from './users.js';

export interface UpdateProfileInput {
	/** undefined = leave unchanged; '' / null clears it back to the username default. */
	displayName?: string | null;
	/** Both required together to change the password; omit both to skip. */
	currentPassword?: string;
	newPassword?: string;
}

/** Update the caller's own display name and/or password. A password change
 *  requires the current password (defense against a hijacked/left-open
 *  session); hashing happens BEFORE the transaction (async, off the tx path). */
export async function updateOwnProfile(userId: number, input: UpdateProfileInput): Promise<void> {
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
