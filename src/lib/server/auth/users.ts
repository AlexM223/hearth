/**
 * Users: first-run admin bootstrap (DECISIONS.md §4.3), password login, and
 * the forced credential-reset flow. Umbrel's deterministic `${APP_PASSWORD}`
 * (surfaced to this app as HEARTH_ADMIN_PASSWORD by docker-compose.yml, see
 * DECISIONS.md §5.2) creates the first Owner account; because that password
 * lives on in the platform's install UI/logs, the account is flagged
 * `must_reset_password` until the human picks their own.
 */
import { getDb, withTransaction } from '../db/index.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { destroyUserSessions, type SessionUser } from './session.js';
import { logWarn } from '../log.js';
import type { Role } from './index.js';

export class AuthError extends Error {
	constructor(
		message: string,
		public code: string
	) {
		super(message);
	}
}

/** Re-exported for callers that only import from users.js. */
export type AuthUser = SessionUser;

interface UserRow {
	id: number;
	username: string;
	password_hash: string;
	role: Role;
	must_reset_password: number;
}

function toAuthUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		mustResetPassword: row.must_reset_password === 1
	};
}

export function userCount(): number {
	const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
	return row.n;
}

export function getUserById(id: number): AuthUser | null {
	const row = getDb()
		.prepare('SELECT id, username, password_hash, role, must_reset_password FROM users WHERE id = ?')
		.get(id) as UserRow | undefined;
	return row ? toAuthUser(row) : null;
}

/**
 * Verify a username + password and return the user. Uses the SAME error for
 * an unknown username and a wrong password, so a login failure never reveals
 * which accounts exist.
 */
export async function loginWithPassword(username: string, password: string): Promise<AuthUser> {
	const normalized = username.trim().toLowerCase();
	const row = getDb()
		.prepare('SELECT id, username, password_hash, role, must_reset_password FROM users WHERE username = ?')
		.get(normalized) as UserRow | undefined;

	if (!row || !(await verifyPassword(password, row.password_hash))) {
		logWarn('auth', { event: 'login_failed', username: normalized });
		throw new AuthError('Invalid username or password.', 'bad_credentials');
	}

	return toAuthUser(row);
}

/**
 * Non-interactive first-run admin bootstrap. If HEARTH_ADMIN_PASSWORD is set
 * and no user exists yet, creates the first Owner with it, flagged
 * must_reset_password so the (app) guard forces a one-time reset before any
 * other route. Idempotent: once a user exists this is a no-op on every
 * subsequent boot, so a container restart can never re-create the admin or
 * re-raise the flag.
 */
export async function bootstrapAdminFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const pw = env.HEARTH_ADMIN_PASSWORD;
	if (!pw || pw.length < MIN_PASSWORD_LENGTH) return;
	if (userCount() > 0) return;

	// Hash BEFORE opening any transaction -- scrypt is async and node:sqlite's
	// DatabaseSync has no notion of a pending transaction across an
	// event-loop tick (db/client.ts's withTransaction doc).
	const passwordHash = await hashPassword(pw);
	withTransaction((db) => {
		db.prepare(
			'INSERT INTO users (username, password_hash, role, must_reset_password) VALUES (?, ?, ?, 1)'
		).run('admin', passwordHash, 'owner');
	});
}

/** Whether this user still has to complete the forced first-login credential reset. */
export function mustResetPassword(userId: number): boolean {
	const row = getDb().prepare('SELECT must_reset_password FROM users WHERE id = ?').get(userId) as
		| { must_reset_password: number }
		| undefined;
	return row?.must_reset_password === 1;
}

/**
 * Complete the forced first-login reset: set an operator-chosen username and
 * password in one step, then clear the flag. Throws AuthError on any
 * problem. The caller is responsible for rotating sessions afterwards (the
 * generated password was visible to anyone who saw the platform's install
 * screen) -- see destroyUserSessions below, called before the new session is
 * issued by the route handler.
 */
export async function completeForcedCredentialReset(
	userId: number,
	input: { username: string; password: string },
	env: NodeJS.ProcessEnv = process.env
): Promise<void> {
	const username = input.username.trim().toLowerCase();
	if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
		throw new AuthError(
			'Username must be 3-32 characters: lowercase letters, numbers, - or _.',
			'invalid_username'
		);
	}
	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'weak_password');
	}
	const bootstrapPw = env.HEARTH_ADMIN_PASSWORD;
	if (bootstrapPw && input.password === bootstrapPw) {
		throw new AuthError(
			'Choose a different password — the install password stays visible on your platform’s setup screen.',
			'reused_bootstrap_password'
		);
	}
	const taken = getDb().prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId);
	if (taken) throw new AuthError('That username is already taken.', 'username_taken');

	// Hash BEFORE the transaction (see bootstrapAdminFromEnv's comment).
	const passwordHash = await hashPassword(input.password);
	withTransaction((db) => {
		db.prepare(
			'UPDATE users SET username = ?, password_hash = ?, must_reset_password = 0 WHERE id = ?'
		).run(username, passwordHash, userId);
	});
	// The bootstrap password was visible in the platform's install UI; any
	// session created with it (including the one completing this reset) must
	// be revoked so the caller mints a fresh one under the new credentials.
	destroyUserSessions(userId);
}
