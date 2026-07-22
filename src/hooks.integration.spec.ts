/**
 * hearth-2s4: an integration test through the REAL hooks.server.ts `handle`
 * (COME-ABOARD.md §3.3/§3.2 -- the deny-by-default policy table + the
 * roleAtLeast floor + touchLastActive + the login-redirect branches). Every
 * other test in the tree calls a `+server.ts` handler directly with a
 * hand-built `locals.user` -- none of them exercise Layer 1 (this hooks
 * module) at all, so a bug in resolveApiPolicy wiring, the 401-vs-403 split,
 * or the redirect branches would never be caught by the suite as it stood.
 *
 * Only the heavy boot-time subsystems (node client, block watcher, mempool
 * ticker, watchtower, notification queue, the notify secret-key file) are
 * mocked out -- they're background infrastructure irrelevant to the
 * request-lifecycle guard this spec targets, and several of them open real
 * sockets / timers / files that have no place in a unit test. `resolve` is
 * the only other mock, per the "mock only the outermost resolve" brief.
 * Everything else (config, db, auth/session/policy/guard) is the real
 * module, driven through constructed Request/event objects.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { DatabaseSync } from 'node:sqlite';

vi.mock('$lib/server/node/index.js', () => ({
	initNodeClient: vi.fn(() => ({ electrum: {}, coreRpc: {} })),
	getNodeClient: vi.fn(() => ({ electrum: {}, coreRpc: {} }))
}));
vi.mock('$lib/server/node/watcher.js', () => ({
	startBlockWatcher: vi.fn(() => ({ stop: vi.fn() })),
	getLastKnownTip: vi.fn(() => null)
}));
vi.mock('$lib/server/chain/index.js', () => ({
	startMempoolTicker: vi.fn(() => ({ stop: vi.fn() }))
}));
vi.mock('$lib/server/notify/config/secrets.js', () => ({
	initSecretKey: vi.fn()
}));
vi.mock('$lib/server/notify/index.js', () => ({
	startWatchtowerService: vi.fn(() => ({})),
	startNotificationQueueWorker: vi.fn(() => ({})),
	initWatchtowerOrigin: vi.fn()
}));

import { openDb, closeDb, getDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { createSession, SESSION_COOKIE, resetActivityThrottle } from '$lib/server/auth/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handle = (input: { event: any; resolve: any }) => Promise<Response>;
let handle: Handle;

beforeAll(async () => {
	vi.stubEnv('HEARTH_DB', ':memory:');
	vi.stubEnv('HEARTH_ADMIN_PASSWORD', ''); // no-op the first-run bootstrap
	vi.stubEnv('HEARTH_PLATFORM', 'dev');
	// hooks.server.ts opens its OWN db + runs migrations + boots at import
	// time (top-level await) -- this is that real module, imported once.
	const mod = await import('./hooks.server.js');
	handle = mod.handle as unknown as Handle;
});

afterAll(() => {
	vi.unstubAllEnvs();
});

function makeEvent(pathname: string, opts: { cookie?: string; method?: string; search?: string } = {}) {
	const url = new URL('http://localhost' + pathname + (opts.search ?? ''));
	return {
		url,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? opts.cookie : undefined) },
		locals: {} as Record<string, unknown>,
		request: new Request(url, { method: opts.method ?? 'GET' }),
		params: {},
		route: { id: pathname },
		getClientAddress: () => '127.0.0.1'
	};
}

function ownerToken(): string {
	const row = getDb().prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: number };
	return createSession(row.id).token;
}

function tokenFor(username: string): string {
	const row = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
	return createSession(row.id).token;
}

function lastActiveOf(username: string): string | null {
	const row = getDb().prepare('SELECT last_active_at FROM users WHERE username = ?').get(username) as {
		last_active_at: string | null;
	};
	return row.last_active_at;
}

beforeEach(() => {
	resetActivityThrottle();
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('guest1', 'h', 'guest');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('member1', 'h', 'member');
});

describe('hearth-2s4: hooks.server.ts handle, end to end', () => {
	it('(a) an unauthenticated /api/** request gets 401 with the unified {message} envelope', async () => {
		const resolve = vi.fn();
		const event = makeEvent('/api/wallets');
		const res = await handle({ event, resolve });
		expect(res.status).toBe(401);
		expect(res.headers.get('content-type')).toContain('application/json');
		const body = await res.json();
		expect(body).toEqual({ message: 'unauthorized' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('(b) an authenticated Guest hitting an owner-only path gets 403 with {message}', async () => {
		const resolve = vi.fn();
		const event = makeEvent('/api/settings/household', { cookie: tokenFor('guest1'), method: 'POST' });
		const res = await handle({ event, resolve });
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body).toEqual({ message: 'forbidden' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('(c) an unmapped /api path is denied by default (403), even for an authenticated Owner', async () => {
		const resolve = vi.fn();
		const event = makeEvent('/api/__totally/unmapped', { cookie: ownerToken() });
		const res = await handle({ event, resolve });
		expect(res.status).toBe(403);
		expect((await res.json()).message).toBe('forbidden');
		expect(resolve).not.toHaveBeenCalled();

		// The deny-by-default case also fires for a fully anonymous caller --
		// the "no rule matched" branch runs BEFORE the role check.
		const anonEvent = makeEvent('/api/__totally/unmapped');
		const anonRes = await handle({ event: anonEvent, resolve });
		expect(anonRes.status).toBe(403);
	});

	it('(d) a valid session reaches resolve() with locals.user populated, and touches last_active_at', async () => {
		expect(lastActiveOf('owner')).toBeNull();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const resolve = vi.fn(async (_event: any) => new Response('ok'));
		const event = makeEvent('/', { cookie: ownerToken() });
		const res = await handle({ event, resolve });
		expect(await res.text()).toBe('ok');
		expect(resolve).toHaveBeenCalledTimes(1);
		const resolvedEvent = resolve.mock.calls[0][0];
		expect(resolvedEvent.locals.user).toMatchObject({ username: 'owner', role: 'owner' });
		expect(lastActiveOf('owner')).not.toBeNull();
	});

	it('(e) an unauthenticated request to a protected page route redirects to /login', async () => {
		const resolve = vi.fn();
		const event = makeEvent('/');
		try {
			await handle({ event, resolve });
			throw new Error('expected handle() to throw a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			expect((e as { status: number; location: string }).status).toBe(303);
			expect((e as { status: number; location: string }).location).toBe('/login');
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it('(e continued) the public /login page itself resolves with no session', async () => {
		const resolve = vi.fn(async () => new Response('login page'));
		const event = makeEvent('/login');
		const res = await handle({ event, resolve });
		expect(await res.text()).toBe('login page');
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('/api/health stays dependency-free: resolves with no session at all', async () => {
		const resolve = vi.fn(async () => new Response('healthy'));
		const event = makeEvent('/api/health');
		const res = await handle({ event, resolve });
		expect(await res.text()).toBe('healthy');
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
