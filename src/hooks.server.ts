/**
 * Server hooks: boot-time DB open + migration run, first-run admin
 * bootstrap, NodeClient + block watcher startup, the session guard (M1),
 * and the "real" crash guard (server.mjs installs a boot-phase fallback
 * using bare console.error before this module -- which uses $lib/server --
 * is even importable; this replaces it once the app has loaded).
 */
import { redirect, type Handle } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config/index.js';
import { openDb, runMigrations } from '$lib/server/db/index.js';
import {
	bootstrapAdminFromEnv,
	getSessionUser,
	SESSION_COOKIE,
	resolveApiPolicy,
	roleAtLeast,
	touchLastActive
} from '$lib/server/auth/index.js';
import { initNodeClient } from '$lib/server/node/index.js';
import { startBlockWatcher } from '$lib/server/node/watcher.js';
import { startMempoolTicker } from '$lib/server/chain/index.js';
import { initSecretKey } from '$lib/server/notify/config/secrets.js';
import {
	startWatchtowerService,
	startNotificationQueueWorker,
	initWatchtowerOrigin
} from '$lib/server/notify/index.js';
import { log } from '$lib/server/log.js';

const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);
await bootstrapAdminFromEnv();
// M6 watchtower: the instance secret-key file backing AES-256-GCM envelopes
// for channel bearer secrets (WATCHTOWER.md §2.3). Idempotent.
initSecretKey(config.dataDir);
initWatchtowerOrigin(config.origin);

const nodeClient = initNodeClient(config.electrum, config.core);
startBlockWatcher(nodeClient);
startMempoolTicker(nodeClient);
// M6 watchtower (T8): the SPV-gated detection service + confirmation/reorg
// reconciliation, and the outbox drain worker for the five external
// channels. Both best-effort and never throw (DECISIONS.md §4.9 invariant
// 4, applied to notify).
startWatchtowerService(nodeClient);
startNotificationQueueWorker();

log('boot', { phase: 'ready', platform: config.platform, dbPath: config.dbPath });

/**
 * Page routes reachable with no session (DECISIONS.md §4.3's "login/invite-
 * landing require no session" carve-out). `/api/health` is handled
 * separately below (it stays dependency-free per M0, and isn't a page).
 * `/join/**` is the captain-identified landing (COME-ABOARD.md §2, §6.3) --
 * public by design, rendered outside the (app) shell.
 */
function isPublicPath(pathname: string): boolean {
	return pathname === '/login' || pathname.startsWith('/join/');
}

function isAsset(pathname: string): boolean {
	return pathname.startsWith('/_app/') || pathname === '/favicon.svg';
}

/** `/settings/**` is Owner-only (COME-ABOARD.md §3.2, §6.3) -- a Member/Guest
 *  hitting it is redirected to their own `/me`, never shown a 403 shell. */
function requiresOwnerPage(pathname: string): boolean {
	return pathname === '/settings' || pathname.startsWith('/settings/');
}

// Replace server.mjs's boot-phase fallback now that the real logger-worthy
// context (structured JSON) is available. Still exits on uncaughtException
// (unknown process state -- never keep serving a wallet app in that state);
// still logs-only on unhandledRejection (a single stray rejection must not
// become a crash loop).
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err) => {
	console.error(
		JSON.stringify({
			t: new Date().toISOString(),
			tag: 'crash',
			kind: 'uncaughtException',
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		})
	);
	setImmediate(() => process.exit(1));
});
process.removeAllListeners('unhandledRejection');
process.on('unhandledRejection', (reason) => {
	console.error(
		JSON.stringify({
			t: new Date().toISOString(),
			tag: 'crash',
			kind: 'unhandledRejection',
			reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
		})
	);
});

function jsonError(status: number, message: string): Response {
	// Normalized to {message} (audit P2#3) -- SvelteKit's own error() helper
	// serializes {message: ...}; these hooks-level denials now match that
	// shape so callers never need a second envelope parser for the edge vs.
	// handler case.
	return new Response(JSON.stringify({ message }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;

	if (isAsset(pathname)) return resolve(event);

	const user = getSessionUser(event.cookies.get(SESSION_COOKIE));
	event.locals.user = user;

	if (pathname === '/api/health') return resolve(event);

	// ---- Layer 1, deny-by-default (COME-ABOARD.md §3.3): every /api/** path
	// resolves against the policy table BEFORE resolve(event) runs. No match
	// => 403. A match whose role minimum isn't met => 401 (no session) or 403
	// (insufficient role). This is Layer 1 of the two-layer gate; every
	// handler ALSO re-checks (Layer 2, auth/guard.ts's requireRole/
	// requireWalletAccess) so a route stays safe even if a policy line is
	// ever dropped by a future refactor.
	if (pathname.startsWith('/api/')) {
		const rule = resolveApiPolicy(pathname, event.request.method);
		if (!rule) return jsonError(403, 'forbidden');
		if (!roleAtLeast(user, rule.min)) {
			return jsonError(user ? 403 : 401, user ? 'forbidden' : 'unauthorized');
		}
		if (user) touchLastActive(user.id);
		return resolve(event);
	}

	if (!user) {
		if (isPublicPath(pathname)) return resolve(event);
		throw redirect(303, '/login');
	}
	touchLastActive(user.id);

	// Authenticated from here on.
	if (pathname === '/login') throw redirect(303, '/');

	if (user.mustResetPassword && pathname !== '/login/reset') {
		throw redirect(303, '/login/reset');
	}
	if (!user.mustResetPassword && pathname === '/login/reset') {
		throw redirect(303, '/');
	}

	if (requiresOwnerPage(pathname) && !roleAtLeast(user, 'owner')) {
		throw redirect(303, '/me');
	}

	return resolve(event);
};
