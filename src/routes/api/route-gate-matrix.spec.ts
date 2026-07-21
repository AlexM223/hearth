/**
 * The M3 headline test (COME-ABOARD.md §7.1): every non-wallet API endpoint
 * x every role, asserting the EXACT status the permission matrix (§3.2)
 * promises. Calls the REAL +server.ts handlers, not a service function
 * directly -- this is the single test that would have caught cairn's
 * viewer-sees-raw-PSBT leak class if a route ever forgot to call its gate.
 *
 * Wallet/PSBT endpoints (which need a real owned wallet + draft to
 * distinguish member-owner from member-other) already have their own
 * exhaustive matrix in src/routes/api/wallets/route-gate.spec.ts (M2,
 * extended in spirit here) -- this file complements it for every OTHER
 * surface T3-T12 added: invites, members, me, household, settings.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { GET as listInvitesRoute, POST as createInviteRoute } from './invites/+server.js';
import { DELETE as revokeInviteRoute } from './invites/[id]/+server.js';
import { GET as listMembersRoute } from './members/+server.js';
import { PATCH as patchMemberRoute, DELETE as offboardRoute } from './members/[id]/+server.js';
import { POST as profileRoute } from './me/profile/+server.js';
import { GET as prefsGetRoute } from './me/prefs/+server.js';
import { GET as householdSummaryRoute } from './household/summary/+server.js';
import { POST as settingsHouseholdRoute } from './settings/household/+server.js';
import { GET as healthRoute } from './health/+server.js';

type Role = 'owner' | 'member' | 'guest' | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: Role, params: Record<string, string> = {}, body?: unknown): any {
	return {
		locals: { user: role == null ? null : { id: 1, username: role ?? 'anon', role, mustResetPassword: false } },
		params,
		url: new URL('http://localhost/api/x'),
		request: { json: async () => body ?? {} }
	};
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		const res = await fn();
		if (res instanceof Response) return res.status;
		throw new Error('handler returned a non-Response value');
	} catch (e) {
		return (e as { status: number }).status;
	}
}

const ROLES: Role[] = ['owner', 'member', 'guest', null];

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
});

interface Row {
	name: string;
	call: (role: Role) => unknown;
	expected: Record<'owner' | 'member' | 'guest' | 'anon', number>;
}

describe('T3-T12 route-gate matrix (every non-wallet endpoint x every role)', () => {
	const rows: Row[] = [
		{
			name: 'GET /api/health (public)',
			call: () => healthRoute(),
			expected: { owner: 200, member: 200, guest: 200, anon: 200 }
		},
		{
			name: 'POST /api/invites (owner-only)',
			call: (role) => createInviteRoute(evt(role, {}, { role: 'member' })),
			expected: { owner: 201, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'GET /api/invites (owner-only)',
			call: (role) => listInvitesRoute(evt(role)),
			expected: { owner: 200, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'DELETE /api/invites/:id (owner-only, unknown id)',
			call: (role) => revokeInviteRoute(evt(role, { id: '999999' })),
			expected: { owner: 404, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'GET /api/members (owner-only)',
			call: (role) => listMembersRoute(evt(role)),
			expected: { owner: 200, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'PATCH /api/members/:id (owner-only, unknown id)',
			call: (role) => patchMemberRoute(evt(role, { id: '999999' }, { role: 'guest' })),
			expected: { owner: 404, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'DELETE /api/members/:id (owner-only, unknown id)',
			call: (role) => offboardRoute(evt(role, { id: '999999' }, {})),
			expected: { owner: 404, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'POST /api/me/profile (any authed, self-scoped)',
			call: (role) => profileRoute(evt(role, {}, { displayName: 'x' })),
			expected: { owner: 200, member: 200, guest: 200, anon: 401 }
		},
		{
			name: 'GET /api/me/prefs (any authed, self-scoped)',
			call: (role) => prefsGetRoute(evt(role)),
			expected: { owner: 200, member: 200, guest: 200, anon: 401 }
		},
		{
			name: 'GET /api/household/summary (owner always; guest denied -- opt-in is off by default)',
			call: (role) => householdSummaryRoute(evt(role)),
			expected: { owner: 200, member: 403, guest: 403, anon: 401 }
		},
		{
			name: 'POST /api/settings/household (owner-only)',
			call: (role) => settingsHouseholdRoute(evt(role, {}, { guestSeesHouseholdBalance: true })),
			expected: { owner: 200, member: 403, guest: 403, anon: 401 }
		}
	];

	for (const row of rows) {
		it(row.name, async () => {
			for (const role of ROLES) {
				const key = (role ?? 'anon') as 'owner' | 'member' | 'guest' | 'anon';
				const status = await statusOf(() => row.call(role));
				expect(status, `${row.name} as ${key}`).toBe(row.expected[key]);
			}
		});
	}

	it('a synthetic unmapped path denies EVERY role, including Owner (deny-by-default)', async () => {
		const { resolveApiPolicy } = await import('$lib/server/auth/policy.js');
		expect(resolveApiPolicy('/api/__unmapped', 'GET')).toBeNull();
		// hooks.server.ts turns a null policy into a 403 for every role -- see
		// hooks.server.ts's handle() and policy.spec.ts's own assertion of this.
	});
});
