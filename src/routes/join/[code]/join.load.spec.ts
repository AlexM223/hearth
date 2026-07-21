/**
 * T6 acceptance (COME-ABOARD.md §2.1, §2.3, §7.3, §8): the pre-auth preview
 * boundary is STRICT. `load` for an open invite returns EXACTLY
 * {state,captain,role,grants} -- no extra keys, no live data -- and this
 * module imports nothing from wallet/chain/member/mining (a static source
 * check, since a future edit adding such an import would be the exact class
 * of leak §2.3 exists to prevent).
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { createInvite } from '$lib/server/auth/invites.js';
import { load } from './+page.server.js';

let ownerId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)').run(
		'alex',
		'h',
		'owner',
		'Alex'
	);
	ownerId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadEvent(code: string): any {
	return { params: { code } };
}

describe('T6: /join/[code] load -- the strict pre-auth boundary', () => {
	it('returns EXACTLY {state,captain,role,grants} for an open Member invite -- no extra keys', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		const data = (await load(loadEvent(code))) as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(['captain', 'grants', 'role', 'state']);
		expect(data.state).toBe('open');
		expect(data.captain).toBe('Alex');
		expect(data.role).toBe('member');
		expect(Array.isArray(data.grants)).toBe(true);
	});

	it('returns EXACTLY {state,captain,role,grants} for an open Guest invite', async () => {
		const { code } = createInvite(ownerId, { role: 'guest' });
		const data = (await load(loadEvent(code))) as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(['captain', 'grants', 'role', 'state']);
		expect(data.role).toBe('guest');
	});

	it('returns ONLY {state:"invalid"} for an unknown code -- no captain/role/grants leak', async () => {
		const data = (await load(loadEvent('not-a-real-code'))) as Record<string, unknown>;
		expect(data).toEqual({ state: 'invalid' });
	});

	it('an expired invite is indistinguishable from unknown at the load layer', async () => {
		const { code } = createInvite(ownerId, { role: 'member', expiresInMs: -1000 });
		const data = (await load(loadEvent(code))) as Record<string, unknown>;
		expect(data).toEqual({ state: 'invalid' });
	});

	it('grants is a compile-time constant, not derived from any live table', async () => {
		const { code } = createInvite(ownerId, { role: 'member' });
		const first = (await load(loadEvent(code))) as { grants: string[] };
		const { code: code2 } = createInvite(ownerId, { role: 'member' });
		const second = (await load(loadEvent(code2))) as { grants: string[] };
		expect(first.grants).toEqual(second.grants);
	});
});

describe('T6: static module-boundary guard (§2.3)', () => {
	it('+page.server.ts imports nothing from wallet/chain/member/mining services', () => {
		const source = readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\$lib\/server\/wallet/);
		expect(source).not.toMatch(/\$lib\/server\/chain/);
		expect(source).not.toMatch(/\$lib\/server\/mining/);
		expect(source).not.toMatch(/\$lib\/server\/node/);
		// Only the auth module (invites/household/accept/session) is imported.
		const libImports = [...source.matchAll(/from '(\$lib\/server\/[^']+)'/g)].map((m) => m[1]);
		expect(libImports.length).toBeGreaterThan(0);
		for (const imp of libImports) expect(imp).toMatch(/^\$lib\/server\/auth\//);
	});
});
