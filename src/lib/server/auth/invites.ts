/**
 * Invite lifecycle (COME-ABOARD.md §1): create/list/revoke/lookup. Codes are
 * stored HASH-ONLY (sha256 hex of a 192-bit base64url token) -- the same
 * mistake cairn made (plaintext `invites.code TEXT UNIQUE`) is the one
 * footgun this module exists to close. The plaintext code is generated here,
 * returned to the caller exactly once (createInvite's return value), and
 * never persisted or retrievable again.
 *
 * The atomic accept/burn transaction (the race-safe conditional UPDATE) is
 * `acceptInvite` in accept.ts (T5) -- this module only covers the Owner-side
 * lifecycle (create/list/revoke) plus the read-only `lookupActiveInvite`
 * that both the pre-flight accept check and the join landing's `load` use.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { hashToken } from './session.js';

export type InviteRole = 'member' | 'guest';
export type InviteState = 'active' | 'expired' | 'exhausted' | 'revoked';

export class InviteError extends Error {
	constructor(
		message: string,
		public code: string
	) {
		super(message);
	}
}

const CODE_BYTES = 24; // 192 bits (COME-ABOARD §1.2) -- unbiased, unlike cairn's randomBytes(4) % 30.

/** A fresh 192-bit base64url invite code. Callers hash it before persisting. */
export function generateInviteCode(): string {
	return randomBytes(CODE_BYTES).toString('base64url');
}

/** sha256 hex -- the ONLY form ever persisted (reuses session.ts's primitive
 *  so invite codes and session tokens are hashed identically). */
export function hashInviteCode(code: string): string {
	return hashToken(code);
}

interface InviteDbRow {
	id: number;
	code_hash: string;
	role: InviteRole;
	created_by: number;
	note: string | null;
	max_uses: number;
	used_count: number;
	revoked: number;
	expires_at: string | null;
	accepted_at: string | null;
	created_at: string;
}

export interface InviteRow {
	id: number;
	role: InviteRole;
	createdBy: number;
	note: string | null;
	maxUses: number;
	usedCount: number;
	revoked: boolean;
	expiresAt: string | null;
	acceptedAt: string | null;
	createdAt: string;
	/** Derived, never a free-text column (COME-ABOARD §1.3). */
	state: InviteState;
}

/** The §1.3 state predicate -- derived, not a stored status column. */
function computeState(row: {
	revoked: number;
	used_count: number;
	max_uses: number;
	expires_at: string | null;
}): InviteState {
	if (row.revoked) return 'revoked';
	if (row.used_count >= row.max_uses) return 'exhausted';
	if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
	return 'active';
}

function hydrate(row: InviteDbRow): InviteRow {
	return {
		id: row.id,
		role: row.role,
		createdBy: row.created_by,
		note: row.note,
		maxUses: row.max_uses,
		usedCount: row.used_count,
		revoked: row.revoked === 1,
		expiresAt: row.expires_at,
		acceptedAt: row.accepted_at,
		createdAt: row.created_at,
		state: computeState(row)
	};
}

export interface CreateInviteInput {
	role: string; // validated below -- never trust the HTTP body's type
	note?: string | null;
	/** Milliseconds from now until expiry; null/undefined = never expires. */
	expiresInMs?: number | null;
	/** Default 1 (single-use, the safest default per §1.2). */
	maxUses?: number;
}

export interface CreatedInvite {
	id: number;
	/** PLAINTEXT -- returned exactly once. Never stored, never re-derivable. */
	code: string;
	role: InviteRole;
	expiresAt: string | null;
	maxUses: number;
}

const VALID_ROLES: readonly InviteRole[] = ['member', 'guest'];

/** Create + persist a new invite. The DB CHECK (role IN ('member','guest'))
 *  is a hard invariant, but we validate here too for a clean error message
 *  instead of a raw constraint-violation exception (§1.1's "cannot invite an
 *  Owner" note -- a leaked link must never be able to mint an Owner). */
export function createInvite(createdBy: number, input: CreateInviteInput): CreatedInvite {
	if (!VALID_ROLES.includes(input.role as InviteRole)) {
		throw new InviteError(
			'An invite can only grant Member or Guest -- Owner is never invite-mintable.',
			'invalid_role'
		);
	}
	const role = input.role as InviteRole;
	const maxUses = input.maxUses != null && input.maxUses > 0 ? Math.floor(input.maxUses) : 1;
	const expiresAt =
		input.expiresInMs == null ? null : new Date(Date.now() + input.expiresInMs).toISOString();
	const note = input.note?.trim() || null;

	const code = generateInviteCode();
	const codeHash = hashInviteCode(code);

	const result = getDb()
		.prepare(
			`INSERT INTO invites (code_hash, role, created_by, max_uses, expires_at, note)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(codeHash, role, createdBy, maxUses, expiresAt, note);

	return { id: Number(result.lastInsertRowid), code, role, expiresAt, maxUses };
}

/** Every invite, household-wide -- any Owner manages any invite (§5.1's
 *  "Pending invites" roster). NEVER returns a code (hash-only storage, and
 *  the plaintext was never persisted in the first place). */
export function listInvites(): InviteRow[] {
	const rows = getDb().prepare('SELECT * FROM invites ORDER BY id DESC').all() as unknown as InviteDbRow[];
	return rows.map(hydrate);
}

export function getInvite(id: number): InviteRow | null {
	const row = getDb().prepare('SELECT * FROM invites WHERE id = ?').get(id) as InviteDbRow | undefined;
	return row ? hydrate(row) : null;
}

/** Soft-revoke (idempotent: true iff a row exists, even if already
 *  revoked/expired/exhausted -- §1.3). An in-flight acceptance can still win
 *  the race against a revoke that lands mid-accept (§1.4/§1.5). */
export function revokeInvite(id: number): boolean {
	const res = getDb().prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(id);
	return Number(res.changes) > 0;
}

/** Look up an invite by its PLAINTEXT code, returning it ONLY if currently
 *  active. Used by the join landing's `load` (T6) and acceptInvite's
 *  pre-flight read (T5) -- never differentiates "unknown" from "expired"
 *  from "revoked" to the caller (§1.5's undifferentiated dead-end). */
export function lookupActiveInvite(code: string): InviteRow | null {
	const row = getDb().prepare('SELECT * FROM invites WHERE code_hash = ?').get(hashInviteCode(code)) as
		| InviteDbRow
		| undefined;
	if (!row) return null;
	const invite = hydrate(row);
	return invite.state === 'active' ? invite : null;
}
