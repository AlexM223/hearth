/**
 * T4 acceptance (COME-ABOARD.md §7.2, §8): calls the REAL +server.ts handlers
 * (house pattern, see wallets/route-gate.spec.ts). Owner creates -> {code,url}
 * once; list never returns a code; revoke flips state; non-owners are denied.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { GET as listInvitesRoute, POST as createInviteRoute } from './+server.js';
import { DELETE as revokeInviteRoute } from './[id]/+server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'owner' | 'member' | 'guest' | null, params: Record<string, string> = {}, body?: unknown): any {
	return {
		locals: { user: role == null ? null : { id: 1, username: role, role, mustResetPassword: false } },
		params,
		url: new URL('http://localhost/api/invites'),
		request: { json: async () => body }
	};
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		if (res instanceof Response) {
			expect(res.status).toBe(status);
			return await res.json();
		}
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		const err = e as { status?: number; body?: unknown };
		expect(err.status).toBe(status);
		return err.body;
	}
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
});

describe('T4: /api/invites route gate', () => {
	it('owner POST creates an invite, returning {code,url} once', async () => {
		const body = (await expectStatus(
			() => createInviteRoute(evt('owner', {}, { role: 'member' })),
			201
		)) as { id: number; code: string; url: string; role: string };
		expect(body.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(body.url).toContain(`/join/${body.code}`);
		expect(body.role).toBe('member');
	});

	it('member/guest/anon cannot create an invite', async () => {
		await expectStatus(() => createInviteRoute(evt('member', {}, { role: 'guest' })), 403);
		await expectStatus(() => createInviteRoute(evt('guest', {}, { role: 'guest' })), 403);
		await expectStatus(() => createInviteRoute(evt(null, {}, { role: 'guest' })), 401);
	});

	it('creating an owner-role invite is rejected with 400', async () => {
		await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'owner' })), 400);
	});

	it('GET list never includes a code, even for the owner', async () => {
		await createInviteRoute(evt('owner', {}, { role: 'guest' }));
		const body = (await expectStatus(() => listInvitesRoute(evt('owner')), 200)) as { invites: unknown[] };
		expect(body.invites.length).toBe(1);
		expect(JSON.stringify(body.invites)).not.toMatch(/"code"/);
	});

	it('member/guest/anon cannot list invites', async () => {
		await expectStatus(() => listInvitesRoute(evt('member')), 403);
		await expectStatus(() => listInvitesRoute(evt('guest')), 403);
		await expectStatus(() => listInvitesRoute(evt(null)), 401);
	});

	it('owner DELETE revokes; a re-list shows state=revoked', async () => {
		const created = (await expectStatus(
			() => createInviteRoute(evt('owner', {}, { role: 'member' })),
			201
		)) as { id: number };
		await expectStatus(() => revokeInviteRoute(evt('owner', { id: String(created.id) })), 200);
		const body = (await expectStatus(() => listInvitesRoute(evt('owner')), 200)) as {
			invites: { id: number; state: string }[];
		};
		expect(body.invites.find((i) => i.id === created.id)!.state).toBe('revoked');
	});

	it('revoking a nonexistent invite is 404; revoking as non-owner is 403/401', async () => {
		await expectStatus(() => revokeInviteRoute(evt('owner', { id: '999999' })), 404);
		await expectStatus(() => revokeInviteRoute(evt('member', { id: '1' })), 403);
		await expectStatus(() => revokeInviteRoute(evt(null, { id: '1' })), 401);
	});

	// Audit P2#8 (hearth-276): expiresInMs/maxUses used to pass through
	// unchecked, poisoning createInvite's `new Date(Date.now() + expiresInMs)`
	// into a raw RangeError (an uncaught 500) whenever expiresInMs wasn't a
	// finite positive number.
	describe('P2#8: expiresInMs/maxUses validation', () => {
		it('a non-numeric expiresInMs (e.g. a string) is a 400, not a 500', async () => {
			const body = (await expectStatus(
				() => createInviteRoute(evt('owner', {}, { role: 'member', expiresInMs: 'soon' })),
				400
			)) as { message?: string };
			expect(body?.message).toMatch(/expiresInMs/);
		});

		it('a zero or negative expiresInMs is a 400', async () => {
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', expiresInMs: 0 })), 400);
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', expiresInMs: -1000 })), 400);
		});

		it('an expiresInMs beyond the one-year cap is a 400', async () => {
			const overCap = 365 * 24 * 60 * 60 * 1000 + 1;
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', expiresInMs: overCap })), 400);
		});

		it('a boundary-valid expiresInMs (exactly one year) is accepted', async () => {
			const oneYear = 365 * 24 * 60 * 60 * 1000;
			await expectStatus(
				() => createInviteRoute(evt('owner', {}, { role: 'member', expiresInMs: oneYear })),
				201
			);
		});

		it('a non-integer, zero, negative, or over-cap maxUses is a 400', async () => {
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', maxUses: 1.5 })), 400);
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', maxUses: 0 })), 400);
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', maxUses: -5 })), 400);
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', maxUses: 1001 })), 400);
		});

		it('a boundary-valid maxUses (exactly the 1000 cap) is accepted', async () => {
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member', maxUses: 1000 })), 201);
		});

		it('omitting expiresInMs/maxUses entirely (defaults) still works', async () => {
			await expectStatus(() => createInviteRoute(evt('owner', {}, { role: 'member' })), 201);
		});
	});
});
