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
import { bootstrapAdminFromEnv, getSessionUser, SESSION_COOKIE } from '$lib/server/auth/index.js';
import { initNodeClient } from '$lib/server/node/index.js';
import { startBlockWatcher } from '$lib/server/node/watcher.js';
import { log } from '$lib/server/log.js';

const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);
await bootstrapAdminFromEnv();

const nodeClient = initNodeClient(config.electrum, config.core);
startBlockWatcher(nodeClient);

log('boot', { phase: 'ready', platform: config.platform, dbPath: config.dbPath });

/**
 * Routes reachable with no session (DECISIONS.md §4.3's "login/invite-
 * landing require no session" carve-out; invite-landing itself arrives in
 * M3). `/api/health` stays dependency-free per M0.
 */
function isPublicPath(pathname: string): boolean {
	return pathname === '/login' || pathname === '/api/health';
}

function isAsset(pathname: string): boolean {
	return pathname.startsWith('/_app/') || pathname === '/favicon.svg';
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

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;

	if (isAsset(pathname)) return resolve(event);

	const user = getSessionUser(event.cookies.get(SESSION_COOKIE));
	event.locals.user = user;

	if (pathname === '/api/health') return resolve(event);

	if (!user) {
		if (isPublicPath(pathname)) return resolve(event);
		if (pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		throw redirect(303, '/login');
	}

	// Authenticated from here on.
	if (pathname === '/login') throw redirect(303, '/');

	if (user.mustResetPassword && pathname !== '/login/reset') {
		throw redirect(303, '/login/reset');
	}
	if (!user.mustResetPassword && pathname === '/login/reset') {
		throw redirect(303, '/');
	}

	return resolve(event);
};
