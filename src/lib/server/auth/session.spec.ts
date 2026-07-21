import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, closeDb, runMigrations, getDb } from '../db/index.js';
import {
	SESSION_COOKIE,
	createSession,
	getSessionUser,
	destroySession,
	destroyUserSessions,
	cookieSecure,
	setSessionCookie,
	hashToken
} from './session.js';

function seedUser(): number {
	const result = getDb()
		.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
		.run('alex', 'scrypt:16384:8:1:salt:hash', 'owner');
	return Number(result.lastInsertRowid);
}

describe('auth: session lifecycle', () => {
	let userId: number;

	beforeEach(() => {
		const db = openDb(':memory:');
		runMigrations(db);
		userId = seedUser();
	});

	afterEach(() => {
		closeDb();
	});

	it('creates a session and resolves it back to the same user', () => {
		const { token, expiresAt } = createSession(userId);
		expect(token).toHaveLength(43); // base64url(32 bytes)
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

		const user = getSessionUser(token);
		expect(user).not.toBeNull();
		expect(user?.id).toBe(userId);
		expect(user?.username).toBe('alex');
		expect(user?.role).toBe('owner');
	});

	it('never stores the raw token -- only its SHA-256 hash', () => {
		const { token } = createSession(userId);
		const row = getDb().prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
		expect(row.token_hash).toBe(hashToken(token));
		expect(row.token_hash).not.toBe(token);
	});

	it('returns null for an unknown token', () => {
		expect(getSessionUser('not-a-real-token')).toBeNull();
		expect(getSessionUser(undefined)).toBeNull();
	});

	it('expires and self-deletes a session past its expiry', () => {
		const { token } = createSession(userId);
		// Backdate the session's expiry directly (createSession always mints 30d out).
		getDb()
			.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
			.run(new Date(Date.now() - 1000).toISOString(), hashToken(token));

		expect(getSessionUser(token)).toBeNull();
		const remaining = getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
		expect(remaining.n).toBe(0);
	});

	it('destroySession removes exactly that session', () => {
		const a = createSession(userId);
		const b = createSession(userId);
		destroySession(a.token);
		expect(getSessionUser(a.token)).toBeNull();
		expect(getSessionUser(b.token)).not.toBeNull();
	});

	it('destroyUserSessions revokes every session for a user', () => {
		const a = createSession(userId);
		const b = createSession(userId);
		destroyUserSessions(userId);
		expect(getSessionUser(a.token)).toBeNull();
		expect(getSessionUser(b.token)).toBeNull();
	});

	it('SESSION_COOKIE is the DECISIONS.md §4.3 cookie name', () => {
		expect(SESSION_COOKIE).toBe('hearth_session');
	});
});

describe('auth: cookieSecure (the app_proxy plain-HTTP fix, DECISIONS.md §5.2)', () => {
	const originalOrigin = process.env.HEARTH_ORIGIN;

	afterEach(() => {
		if (originalOrigin === undefined) delete process.env.HEARTH_ORIGIN;
		else process.env.HEARTH_ORIGIN = originalOrigin;
	});

	it('follows the request protocol when HEARTH_ORIGIN is unset', () => {
		delete process.env.HEARTH_ORIGIN;
		expect(cookieSecure(new URL('https://example.com'))).toBe(true);
		expect(cookieSecure(new URL('http://example.com'))).toBe(false);
	});

	it('forces non-Secure when HEARTH_ORIGIN declares plain HTTP, even if the request looks https', () => {
		process.env.HEARTH_ORIGIN = 'http://umbrel.local:3000';
		// adapter-node can misreport the request URL as https behind app_proxy
		// with no PROTOCOL_HEADER configured -- the declared origin must win.
		expect(cookieSecure(new URL('https://umbrel.local:3000/login'))).toBe(false);
	});

	it('falls back to the request protocol on a malformed HEARTH_ORIGIN', () => {
		process.env.HEARTH_ORIGIN = 'not a url';
		expect(cookieSecure(new URL('https://example.com'))).toBe(true);
	});
});

describe('auth: setSessionCookie shape -- the origin-hop hard rule (SIGNING.md §4.4)', () => {
	// The session cookie MUST stay SameSite=Lax, non-Secure on plain-HTTP
	// deployments, and host-scoped (no Domain attribute) -- "hardening" any of
	// these silently breaks either the HTTP->HTTPS signing-surface hop or
	// plain-HTTP login entirely. Pinned here as a structural regression test
	// on the exact options object handed to `cookies.set`.
	it('sets path=/, httpOnly, sameSite=lax, and NEVER a domain attribute', () => {
		const set = vi.fn();
		const cookies = { set } as unknown as import('@sveltejs/kit').Cookies;
		setSessionCookie(cookies, 'tok', new Date(Date.now() + 1000), new URL('http://umbrel.local:3252/'));

		expect(set).toHaveBeenCalledTimes(1);
		const [name, value, opts] = set.mock.calls[0];
		expect(name).toBe(SESSION_COOKIE);
		expect(value).toBe('tok');
		expect(opts).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax', secure: false });
		expect(opts).not.toHaveProperty('domain');
	});

	it('is non-Secure on a plain-HTTP declared origin even when called from the HTTPS hop URL', () => {
		// The hop is http://host:3252 -> https://host:4489; the cookie the
		// browser already carries was minted non-Secure (HEARTH_ORIGIN is
		// http:), so it must stay valid on the https request too -- a
		// Secure=true cookie set here would still be ACCEPTED over https, but
		// asserting non-Secure pins that this path never "upgrades" the
		// cookie based on the request URL's own scheme (cookieSecure follows
		// the DECLARED origin, not the request).
		const originalOrigin = process.env.HEARTH_ORIGIN;
		process.env.HEARTH_ORIGIN = 'http://umbrel.local:3252';
		try {
			const set = vi.fn();
			const cookies = { set } as unknown as import('@sveltejs/kit').Cookies;
			setSessionCookie(cookies, 'tok', new Date(Date.now() + 1000), new URL('https://umbrel.local:4489/wallets/1'));
			const [, , opts] = set.mock.calls[0];
			expect(opts.secure).toBe(false);
			expect(opts.sameSite).toBe('lax');
		} finally {
			if (originalOrigin === undefined) delete process.env.HEARTH_ORIGIN;
			else process.env.HEARTH_ORIGIN = originalOrigin;
		}
	});
});
