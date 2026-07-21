/**
 * Production entry point: adapter-node's request handler on plain HTTP, plus
 * an optional self-signed HTTPS listener (DECISIONS.md §2 "Entry point",
 * §5.1). Pattern ported from cairn's server.mjs.
 *
 * Why not `node build` (adapter-node's own server)? It only speaks HTTP. On
 * Umbrel -- plain HTTP on the LAN, no platform TLS -- that leaves the
 * browser without a secure context, so WebHID / Web Serial hardware-wallet
 * signing and camera QR scanning are unavailable. This wrapper serves the
 * SAME app on a second, TLS port using a certificate generated at first boot
 * (see scripts/tls-cert.mjs).
 *
 * Startup order matters: Docker starts forwarding published host ports the
 * moment the container starts, so every second before a listener binds shows
 * up to the browser as ERR_EMPTY_RESPONSE. Importing the SvelteKit bundle is
 * the slow part of boot (DB open, migrations, Electrum pool once those land),
 * so both listeners bind FIRST with a self-refreshing 503 placeholder, and
 * the real handler is swapped in when the app finishes loading.
 *
 * Environment:
 *   PORT / HOST              -- HTTP listener (adapter-node conventions; default 3000).
 *   HEARTH_HTTPS_PORT        -- enable the HTTPS listener on this port. Unset = off.
 *   HEARTH_TLS_DIR           -- where key.pem/cert.pem persist. Default: <dir of
 *                               HEARTH_DB>/tls, falling back to ./data/tls.
 *   HEARTH_HTTPS_EXTERNAL_PORT -- the HOST-visible port the UI should link to
 *                               when it differs from HEARTH_HTTPS_PORT (Docker
 *                               port mapping); read by the app, not by this file.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { ensureCert } from './scripts/tls-cert.mjs';
import { fillForwardedProto } from './scripts/serverProto.mjs';

/**
 * Process-level crash guard, boot-phase fallback. There is no
 * uncaughtException/unhandledRejection handler anywhere else this early, so
 * a stray throw before the app finishes loading would otherwise kill the
 * process with a bare Node stack trace and no structured log line.
 */
if (process.listenerCount('uncaughtException') === 0) {
	process.on('uncaughtException', (err) => {
		console.error('hearth: uncaughtException (boot-phase fallback, exiting) —', err);
		// A synchronous throw means process state is unknown -- this is a
		// wallet app; never keep serving requests in an undefined state.
		setImmediate(() => process.exit(1));
	});
	process.on('unhandledRejection', (reason) => {
		// Log-only: a single benign stray rejection must never turn into a crash loop.
		console.error('hearth: unhandledRejection (boot-phase fallback, not exiting) —', reason);
	});
}

const httpPort = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const httpsPort = process.env.HEARTH_HTTPS_PORT ? Number(process.env.HEARTH_HTTPS_PORT) : null;

/**
 * Catch-all NDJSON access log. This wrapper is the only layer that observes
 * the final res.statusCode for every response on BOTH listeners -- including
 * responses produced before hooks.server.ts's `handle` hook ever runs
 * (framework CSRF 403, adapter body-size-limit 400, this file's own 503
 * "still booting" placeholder).
 */
function withAccessLog(proto, next) {
	return (req, res) => {
		const start = process.hrtime.bigint();
		let logged = false;
		const done = (aborted) => {
			if (logged) return;
			logged = true;
			const ms = Number(process.hrtime.bigint() - start) / 1e6;
			const status = res.statusCode;
			const pathOnly = (req.url || '').split('?')[0];
			const isAsset = pathOnly.startsWith('/_app/');
			const isHealth = pathOnly === '/api/health';
			const emit = aborted || status >= 400 || (!isAsset && !isHealth && ms >= 1000);
			if (!emit) return;
			console.log(
				JSON.stringify({
					t: new Date().toISOString(),
					tag: 'access',
					proto,
					method: req.method,
					path: pathOnly,
					status,
					ms: Math.round(ms),
					aborted: aborted || undefined
				})
			);
		};
		res.on('finish', () => done(false));
		res.on('close', () => {
			if (!res.writableFinished) done(true);
		});
		next(req, res);
	};
}

/**
 * Swappable request handler: starts as a "still booting" 503 that refreshes
 * itself, becomes the SvelteKit handler once ./build/handler.js has loaded.
 */
let handle = (req, res) => {
	res.writeHead(503, {
		'content-type': 'text/html; charset=utf-8',
		'retry-after': '2',
		'cache-control': 'no-store'
	});
	res.end(
		'<!doctype html><meta http-equiv="refresh" content="2"><title>Hearth is starting…</title>' +
			'<p style="font-family:system-ui;margin:3rem auto;max-width:30rem;text-align:center">' +
			'Hearth is starting up — this page will retry by itself.</p>'
	);
};

const servers = [];

const httpServer = http.createServer(
	withAccessLog('http', (req, res) => {
		fillForwardedProto(req.headers, 'http');
		handle(req, res);
	})
);
httpServer.listen(httpPort, host, () => {
	console.log(`hearth: http listening on ${host}:${httpPort}`);
});
servers.push(httpServer);

if (httpsPort) {
	const tlsDir =
		process.env.HEARTH_TLS_DIR ??
		(process.env.HEARTH_DB
			? path.join(path.dirname(process.env.HEARTH_DB), 'tls')
			: path.join(process.cwd(), 'data', 'tls'));
	try {
		const { key, cert } = await ensureCert(tlsDir);
		const httpsServer = https.createServer(
			{ key, cert },
			withAccessLog('https', (req, res) => {
				fillForwardedProto(req.headers, 'https');
				handle(req, res);
			})
		);
		httpsServer.listen(httpsPort, host, () => {
			console.log(`hearth: https listening on ${host}:${httpsPort} (self-signed, ${tlsDir})`);
		});
		servers.push(httpsServer);
	} catch (err) {
		// HTTPS is an enhancement; a cert problem must never take down the app.
		console.error('hearth: https listener disabled —', err?.message ?? err);
	}
}

// Default per-listener protocol resolution for unconfigured (bare-node) deployments.
// If ORIGIN is set, adapter-node ignores protocol headers entirely (honored).
// If the operator set PROTOCOL_HEADER, honor theirs.
if (!process.env.ORIGIN && !process.env.PROTOCOL_HEADER) {
	process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
}

let handler;
try {
	({ handler } = await import('./build/handler.js'));
} catch (err) {
	console.error(
		JSON.stringify({
			t: new Date().toISOString(),
			tag: 'boot',
			phase: 'app-import',
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		})
	);
	setImmediate(() => process.exit(1));
	await new Promise(() => {});
}
handle = handler;
console.log('hearth: app ready');

function shutdown(signal) {
	console.log(`hearth: ${signal} received, shutting down`);
	let open = servers.length;
	for (const server of servers) {
		server.close(() => {
			if (--open === 0) process.exit(0);
		});
	}
	// Idle keep-alive sockets keep close() pending; don't hang the container.
	setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
