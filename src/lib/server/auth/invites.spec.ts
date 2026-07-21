/**
 * T3 acceptance (COME-ABOARD.md §7.2, §8): hash-only storage, state
 * derivation, owner-role rejection, code generation. The atomic accept/burn
 * transaction is covered separately in accept.spec.ts (T5).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, getDb, closeDb, runMigrations } from '../db/index.js';
import {
	createInvite,
	listInvites,
	getInvite,
	revokeInvite,
	lookupActiveInvite,
	generateInviteCode,
	hashInviteCode,
	InviteError
} from './invites.js';

let ownerId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	ownerId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

describe('T3: invite service', () => {
	it('generates a 192-bit base64url code (32 chars, URL-safe)', () => {
		const code = generateInviteCode();
		expect(code.length).toBe(32);
		expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('two generated codes are never equal (collision-free in practice)', () => {
		expect(generateInviteCode()).not.toBe(generateInviteCode());
	});

	it('stores ONLY the hash -- no plaintext column ever holds the code', () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		const rows = listInvites();
		expect(rows.length).toBe(1);
		const raw = JSON.stringify(rows);
		expect(raw).not.toContain(code);
		// The hash IS derivable and consistent:
		expect(hashInviteCode(code)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects an attempt to mint an Owner invite', () => {
		expect(() => createInvite(ownerId, { role: 'owner' })).toThrow(InviteError);
		try {
			createInvite(ownerId, { role: 'owner' });
		} catch (e) {
			expect((e as InviteError).code).toBe('invalid_role');
		}
	});

	it('rejects a garbage role string', () => {
		expect(() => createInvite(ownerId, { role: 'superadmin' })).toThrow(InviteError);
	});

	it('defaults to single-use, no expiry', () => {
		const { id } = createInvite(ownerId, { role: 'guest' });
		const invite = getInvite(id)!;
		expect(invite.maxUses).toBe(1);
		expect(invite.expiresAt).toBeNull();
		expect(invite.state).toBe('active');
	});

	it('an expired invite (expiresInMs already in the past) derives state=expired', () => {
		const { id } = createInvite(ownerId, { role: 'member', expiresInMs: -1000 });
		expect(getInvite(id)!.state).toBe('expired');
	});

	it('a revoked invite derives state=revoked and lookupActiveInvite returns null', () => {
		const { id, code } = createInvite(ownerId, { role: 'member' });
		expect(revokeInvite(id)).toBe(true);
		expect(getInvite(id)!.state).toBe('revoked');
		expect(lookupActiveInvite(code)).toBeNull();
	});

	it('revoking a nonexistent invite id is a no-op (returns false)', () => {
		expect(revokeInvite(999999)).toBe(false);
	});

	it('lookupActiveInvite finds an active invite by its plaintext code', () => {
		const { code, role } = createInvite(ownerId, { role: 'guest' });
		const found = lookupActiveInvite(code);
		expect(found).not.toBeNull();
		expect(found!.role).toBe(role);
	});

	it('lookupActiveInvite returns null for an unknown code (no oracle)', () => {
		expect(lookupActiveInvite('not-a-real-code')).toBeNull();
	});

	it('an exhausted invite (used_count >= max_uses) is not active', () => {
		const { id, code } = createInvite(ownerId, { role: 'guest', maxUses: 1 });
		// Simulate a burn directly (T5 owns the real atomic burn transaction).
		getDb().prepare('UPDATE invites SET used_count = used_count + 1 WHERE id = ?').run(id);
		expect(getInvite(id)!.state).toBe('exhausted');
		expect(lookupActiveInvite(code)).toBeNull();
	});

	it('listInvites is household-wide and ordered newest-first', () => {
		const a = createInvite(ownerId, { role: 'member' });
		const b = createInvite(ownerId, { role: 'guest' });
		const rows = listInvites();
		expect(rows[0].id).toBe(b.id);
		expect(rows[1].id).toBe(a.id);
	});
});
