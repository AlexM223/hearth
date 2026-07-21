/**
 * Owner-sees-all cross-member roll-up (COME-ABOARD.md §4). Read-only,
 * never a member's draft PSBT, address, xpub, or credential -- the roster
 * query selects no such columns, and the balance figure comes from the
 * wallet module's own SWR snapshot reader (getSnapshot), never
 * `psbt_drafts`/`addresses` directly.
 *
 * Role change + offboard (§5) live in this file too (T11) since they operate
 * on the same roster the Owner is looking at.
 */
import { getDb, withTransaction } from '../db/index.js';
import { destroyUserSessions } from './session.js';
import type { Role } from './index.js';

export type ActivityBucket = 'active recently' | 'this week' | 'dormant' | 'never';

/** Coarsened liveness, never an exact timestamp (§4's "bucket, not a log"). */
export function activityBucket(lastActiveAt: string | null, now = Date.now()): ActivityBucket {
	if (!lastActiveAt) return 'never';
	const ageMs = now - new Date(lastActiveAt).getTime();
	const HOUR = 3_600_000;
	if (ageMs <= 24 * HOUR) return 'active recently';
	if (ageMs <= 7 * 24 * HOUR) return 'this week';
	return 'dormant';
}

export interface MemberRow {
	id: number;
	username: string;
	displayName: string | null;
	role: Role;
	confirmedSats: number;
	unconfirmedSats: number;
	walletCount: number;
	activity: ActivityBucket;
	invitedByUsername: string | null;
	createdAt: string;
}

interface UserRosterRow {
	id: number;
	username: string;
	display_name: string | null;
	role: Role;
	last_active_at: string | null;
	invited_by_username: string | null;
	created_at: string;
}

/**
 * The full household roster (§4, §5.1). Deliberately selects NO
 * password_hash, NO session tokens, and joins nothing from
 * wallets/addresses/psbt_drafts directly -- per-member balance is filled in
 * by the caller from the wallet module's own SWR reader, which is itself
 * balance-only (never a draft, never an address).
 */
function rosterUsers(): UserRosterRow[] {
	return getDb()
		.prepare(
			`SELECT u.id, u.username, u.display_name, u.role, u.last_active_at, u.created_at,
			        inviter.username AS invited_by_username
			 FROM users u
			 LEFT JOIN users inviter ON inviter.id = u.invited_by
			 ORDER BY u.id ASC`
		)
		.all() as unknown as UserRosterRow[];
}

export interface WalletBalanceReader {
	/** wallet ids owned by this user (id + confirmed/unconfirmed snapshot). */
	(userId: number): { confirmedSats: number; unconfirmedSats: number }[];
}

/** Builds the roster, given a caller-supplied balance reader (dependency-
 *  injected so this module never imports the wallet engine's SQL directly --
 *  it goes through the wallet module's own public, balance-only surface). */
export function listMembers(readBalances: WalletBalanceReader): MemberRow[] {
	const now = Date.now();
	return rosterUsers().map((u) => {
		const balances = readBalances(u.id);
		return {
			id: u.id,
			username: u.username,
			displayName: u.display_name,
			role: u.role,
			confirmedSats: balances.reduce((s, b) => s + b.confirmedSats, 0),
			unconfirmedSats: balances.reduce((s, b) => s + b.unconfirmedSats, 0),
			walletCount: balances.length,
			activity: activityBucket(u.last_active_at, now),
			invitedByUsername: u.invited_by_username,
			createdAt: u.created_at
		};
	});
}

export interface HouseholdSummary {
	memberCount: number; // invited members+guests (never counts the Owner)
	confirmedSats: number; // household-wide, INCLUDING the Owner's own wallets
	unconfirmedSats: number;
}

export function householdSummary(readBalances: WalletBalanceReader): HouseholdSummary {
	const users = rosterUsers();
	let confirmedSats = 0;
	let unconfirmedSats = 0;
	let memberCount = 0;
	for (const u of users) {
		if (u.role !== 'owner') memberCount++;
		for (const b of readBalances(u.id)) {
			confirmedSats += b.confirmedSats;
			unconfirmedSats += b.unconfirmedSats;
		}
	}
	return { memberCount, confirmedSats, unconfirmedSats };
}

// ------------------------------------------------------------- role change

export class MemberError extends Error {
	constructor(
		message: string,
		public code: string
	) {
		super(message);
	}
}

const VALID_ROLES: readonly Role[] = ['owner', 'member', 'guest'];

/**
 * Change a user's role (§5.2). Enforced in ONE transaction: after applying
 * the change, `COUNT(*) WHERE role='owner'` must stay >= 1, else rollback
 * with LastOwner -- an ownerless instance is unadministrable (no one could
 * invite, revoke, change settings, or offboard).
 */
export function changeMemberRole(targetUserId: number, newRole: string): void {
	if (!VALID_ROLES.includes(newRole as Role)) {
		throw new MemberError('Not a valid role.', 'invalid_role');
	}
	withTransaction((db) => {
		const existing = db.prepare('SELECT role FROM users WHERE id = ?').get(targetUserId) as
			| { role: Role }
			| undefined;
		if (!existing) throw new MemberError('Member not found.', 'not_found');

		db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, targetUserId);

		const ownerCount = (
			db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get() as { n: number }
		).n;
		if (ownerCount < 1) {
			throw new MemberError(
				'Promote another member to Owner first — a hearth always needs a keeper.',
				'last_owner'
			);
		}
	});
}

// ----------------------------------------------------------------- offboard

export type OffboardWalletPolicy = 'remove' | 'transfer';

/**
 * Offboard a member (§5.3) -- removes a PERSON, distinct from revoking an
 * invite LINK. Sessions are killed first (every device logged out at once,
 * no grace window). Wallets are either hard-deleted with the user
 * (ON DELETE CASCADE -- coins are untouched on-chain, watch-only, the member
 * keeps their keys) or transferred to the offboarding Owner so the household
 * keeps watching those balances; drafts are NEVER transferred (an
 * offboarded member's unbroadcast intentions aren't the Owner's to inherit).
 */
export function offboardMember(
	offboardingOwnerId: number,
	targetUserId: number,
	walletPolicy: OffboardWalletPolicy = 'remove'
): void {
	withTransaction((db) => {
		const existing = db.prepare('SELECT role FROM users WHERE id = ?').get(targetUserId) as
			| { role: Role }
			| undefined;
		if (!existing) throw new MemberError('Member not found.', 'not_found');

		// Sessions killed FIRST, in this same transaction (§5.3) -- every device
		// the member was signed in on is logged out at once, no grace window.
		// (destroyUserSessions is just one more synchronous statement on the
		// same DatabaseSync handle -- safe to reuse inside an open transaction,
		// same pattern as accept.ts's createSession reuse.)
		destroyUserSessions(targetUserId);

		if (walletPolicy === 'transfer') {
			// Drafts are dropped, not transferred -- delete them before re-parenting
			// the wallets so no orphaned draft survives under the new owner.
			db.prepare(
				`DELETE FROM psbt_drafts WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ?)`
			).run(targetUserId);
			db.prepare('UPDATE wallets SET user_id = ? WHERE user_id = ?').run(offboardingOwnerId, targetUserId);
		}
		// walletPolicy === 'remove': ON DELETE CASCADE on wallets.user_id drops
		// wallets/addresses/utxos/transactions/drafts/wallet_snapshots with the user row.

		db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

		const ownerCount = (
			db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get() as { n: number }
		).n;
		if (ownerCount < 1) {
			throw new MemberError(
				'Promote another member to Owner first — a hearth always needs a keeper.',
				'last_owner'
			);
		}
	});
}
