/**
 * The invite acceptance transaction (COME-ABOARD.md §1.4): validate the FORM
 * first (so a client-side error never burns a code) -> pre-flight read (a
 * friendly "no longer valid" without touching anything) -> hash the password
 * OFF the transaction path (scrypt is async; node:sqlite has no notion of a
 * pending transaction across an event-loop tick) -> ONE synchronous
 * transaction that re-validates + burns the invite via a conditional UPDATE,
 * inserts the user, and opens a session.
 *
 * The burn IS the concurrency gate (§1.4): `WHERE ... AND used_count <
 * max_uses` plus `changes === 1` means that under two simultaneous accepts of
 * a single-use code, SQLite serializes the writes and exactly one UPDATE
 * matches; the loser rolls back with InviteRaceLost. Because the burn and the
 * user INSERT are the same transaction, a failed user insert (username
 * collision) never consumes a use -- the invitee just retries with a new name.
 */
import { withTransaction } from '../db/index.js';
import { hashPassword } from './password.js';
import { MIN_PASSWORD_LENGTH } from './password.js';
import { lookupActiveInvite } from './invites.js';
import { createSession, type SessionUser } from './session.js';
import type { Role } from './index.js';

export class AcceptInviteError extends Error {
	constructor(
		message: string,
		public code: string
	) {
		super(message);
	}
}

export interface AcceptInviteInput {
	code: string;
	username: string;
	password: string;
	confirmPassword: string;
	displayName?: string | null;
}

export interface AcceptedMember {
	user: SessionUser;
	sessionToken: string;
	sessionExpiresAt: Date;
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

/** Same rule everywhere (mirrors completeForcedCredentialReset, users.ts). */
function validateForm(input: AcceptInviteInput): { username: string; displayName: string | null } {
	const username = input.username.trim().toLowerCase();
	if (!USERNAME_RE.test(username)) {
		throw new AcceptInviteError(
			'Username must be 3-32 characters: lowercase letters, numbers, - or _.',
			'invalid_username'
		);
	}
	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new AcceptInviteError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'weak_password');
	}
	if (input.password !== input.confirmPassword) {
		throw new AcceptInviteError('Passwords do not match.', 'password_mismatch');
	}
	return { username, displayName: input.displayName?.trim() || null };
}

/**
 * Accept an invite: the full §1.4 pipeline. Throws AcceptInviteError with a
 * stable `code` for every edge case in §1.5 (all undifferentiated to an
 * anonymous caller at the ROUTE layer -- T6's landing shows one calm dead-end
 * regardless of which `code` fired; the distinct codes here are for
 * logs/tests, not for a probeable UI oracle).
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptedMember> {
	// 1. Validate the form FIRST -- never burn a code on a client-side typo.
	const { username, displayName } = validateForm(input);

	// 2. Pre-flight (read-only): friendly error if the code isn't active. This
	//    is NOT the concurrency gate (the conditional UPDATE below is) -- it
	//    just avoids hashing a password for a code that's obviously dead.
	const invite = lookupActiveInvite(input.code);
	if (!invite) {
		throw new AcceptInviteError('This invitation is no longer valid.', 'invite_invalid');
	}

	// 3. Hash BEFORE opening the transaction -- async, must happen off the tx path.
	const passwordHash = await hashPassword(input.password);

	// 4. ONE synchronous transaction: re-validate + burn, insert user, open session.
	return withTransaction((db) => {
		const burn = db
			.prepare(
				`UPDATE invites
				 SET used_count = used_count + 1,
				     accepted_at = COALESCE(accepted_at, datetime('now'))
				 WHERE id = ?
				   AND revoked = 0
				   AND used_count < max_uses
				   AND (expires_at IS NULL OR expires_at > datetime('now'))`
			)
			.run(invite.id);
		if (Number(burn.changes) !== 1) {
			throw new AcceptInviteError('This link was just used or is no longer valid.', 'invite_race_lost');
		}

		let userId: number;
		try {
			const res = db
				.prepare(
					`INSERT INTO users
					   (username, password_hash, role, must_reset_password, invited_by, created_via_invite, display_name)
					 VALUES (?, ?, ?, 0, ?, ?, ?)`
				)
				.run(username, passwordHash, invite.role, invite.createdBy, invite.id, displayName);
			userId = Number(res.lastInsertRowid);
		} catch {
			// UNIQUE(username) violation -> the whole transaction (including the
			// burn above) rolls back, so the code is NOT consumed (§1.4's note).
			throw new AcceptInviteError('That name’s taken — pick another.', 'username_taken');
		}

		// createSession is a single synchronous INSERT (session.ts) -- safe to
		// call inside this already-open transaction (same DatabaseSync handle).
		const { token, expiresAt } = createSession(userId);

		const user: SessionUser = {
			id: userId,
			username,
			role: invite.role as Role,
			mustResetPassword: false
		};
		return { user, sessionToken: token, sessionExpiresAt: expiresAt };
	});
}
