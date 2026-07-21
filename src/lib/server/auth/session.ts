/**
 * Sessions -- randomBytes(32) bearer tokens, only the SHA-256 hash stored
 * (DECISIONS.md §4.3). Cookie `hearth_session`, non-Secure over plain HTTP
 * (the app_proxy constraint, DECISIONS.md §5.2) -- `cookieSecure()` follows
 * the declared origin's protocol, not the request URL's (adapter-node
 * assumes https when neither ORIGIN nor PROTOCOL_HEADER is configured, which
 * would otherwise make every cookie Secure and silently dropped on
 * plain-HTTP LAN deployments).
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { getDb } from '../db/index.js';
import type { Role } from './index.js';

export const SESSION_COOKIE = 'hearth_session';
const SESSION_DAYS = 30;

export interface SessionUser {
	id: number;
	username: string;
	role: Role;
	mustResetPassword: boolean;
}

/** SHA-256 hex digest of an opaque bearer token -- the only form persisted. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: number): { token: string; expiresAt: Date } {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
	getDb()
		.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
		.run(hashToken(token), userId, expiresAt.toISOString());
	return { token, expiresAt };
}

/** Looks up the session's user, pruning it first if it has expired. */
export function getSessionUser(token: string | undefined): SessionUser | null {
	if (!token) return null;
	const db = getDb();
	const row = db
		.prepare(
			`SELECT u.id, u.username, u.role, u.must_reset_password, s.expires_at
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ?`
		)
		.get(hashToken(token)) as
		| { id: number; username: string; role: Role; must_reset_password: number; expires_at: string }
		| undefined;

	if (!row) return null;
	if (new Date(row.expires_at).getTime() < Date.now()) {
		db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
		return null;
	}
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		mustResetPassword: row.must_reset_password === 1
	};
}

export function destroySession(token: string | undefined): void {
	if (!token) return;
	getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(userId: number): void {
	getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * Whether cookies set for this request should carry the `Secure` flag.
 * Follows the request protocol, EXCEPT when the deployment's declared
 * origin (HEARTH_ORIGIN) says the instance is served over plain HTTP -- that
 * claim can be wrong, since adapter-node assumes https whenever neither
 * ORIGIN nor PROTOCOL_HEADER is configured (DECISIONS.md §5.2's CSRF/origin
 * fix). Behind Umbrel's app_proxy (plain HTTP on the LAN) a Secure cookie
 * would be silently dropped by the browser and login would never stick.
 */
export function cookieSecure(url: URL): boolean {
	const declared = process.env.HEARTH_ORIGIN?.trim();
	if (declared) {
		try {
			if (new URL(declared).protocol === 'http:') return false;
		} catch {
			// Malformed HEARTH_ORIGIN -- fall back to the request protocol.
		}
	}
	return url.protocol === 'https:';
}

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date, url: URL): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(url),
		expires: expiresAt
	});
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(SESSION_COOKIE, { path: '/', secure: cookieSecure(url) });
}
