/**
 * Server hooks: boot-time DB open + migration run, and the "real" crash
 * guard (server.mjs installs a boot-phase fallback using bare console.error
 * before this module -- which uses $lib/server -- is even importable; this
 * replaces it once the app has loaded). Auth/session handling lands in M1.
 */
import type { Handle } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config/index.js';
import { openDb, runMigrations } from '$lib/server/db/index.js';

const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);

console.log(
	JSON.stringify({
		t: new Date().toISOString(),
		tag: 'boot',
		phase: 'ready',
		platform: config.platform,
		dbPath: config.dbPath
	})
);

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
	return resolve(event);
};
