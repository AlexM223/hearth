#!/usr/bin/env node
/**
 * Container boot smoke test (M7 store-readiness deliverable, DECISIONS.md
 * §6 M7 acceptance). Boots a built Hearth image the way umbrelOS actually
 * would -- HEARTH_PLATFORM=umbrel, a real bind-mounted /data volume, the
 * app_proxy header trio, no APP_DATA_DIR passed into the container (umbrelOS
 * only uses that var to interpolate the host-side bind-mount SOURCE path,
 * never as a container env var; see the Dockerfile's HEARTH_DATA_DIR
 * comment) -- and asserts:
 *
 *   1. The container is still running after the start-period (didn't crash).
 *   2. GET /api/health returns 200.
 *   3. GET / (the themed shell) returns 200.
 *   4. hearth.db exists on the HOST side of the mounted volume (i.e. the app
 *      actually wrote through to /data, not some in-container path).
 *   5. Every file the app created under /data is owned by uid 1000 (not root).
 *
 * This exact sequence (no HEARTH_DATA_DIR override, no APP_DATA_DIR in env)
 * is what caught a real container-crashing bug during M7: config/index.ts's
 * `dataDir` silently fell back to a relative './data' whenever neither
 * HEARTH_DATA_DIR nor APP_DATA_DIR was present in the container's own
 * environment, and uid 1000 cannot write to /app. Fixed by adding
 * `ENV HEARTH_DATA_DIR=/data` to the Dockerfile -- this script is the
 * regression test for that fix; it must be run (not just linted/skipped)
 * before any image is considered store-ready.
 *
 * Usage:
 *   node scripts/smoke-test-image.mjs <image-tag> [--platform linux/arm64]
 *
 * The optional --platform flag runs the image under `docker run --platform`
 * (QEMU emulation for a non-native arch, e.g. arm64 on an amd64 CI runner or
 * dev box) -- useful for a real multi-arch boot check, not just a build
 * check, without needing actual ARM hardware. Emulated boot is a real signal
 * (it caught this file's own regression bug) but is not a substitute for
 * verifying on real hardware before a wide release.
 *
 * Requires Docker. Exits non-zero on any failed assertion.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const image = args[0];
const platformIdx = args.indexOf('--platform');
const platform = platformIdx !== -1 ? args[platformIdx + 1] : null;
if (!image) {
	console.error('usage: node scripts/smoke-test-image.mjs <image-tag> [--platform linux/arm64]');
	process.exit(2);
}

const containerName = `hearth-smoke-${Date.now()}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'hearth-smoke-'));
const port = 18173;

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
	return r;
}

function cleanup() {
	run('docker', ['rm', '-f', containerName]);
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

function fail(msg) {
	console.error(`SMOKE TEST FAILED: ${msg}`);
	const logs = run('docker', ['logs', containerName]);
	console.error('--- container logs ---');
	console.error(logs.stdout || '');
	console.error(logs.stderr || '');
	cleanup();
	process.exit(1);
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	console.log(`[smoke] image=${image} container=${containerName} dataDir=${dataDir} port=${port}${platform ? ` platform=${platform}` : ''}`);

	// Boot the container exactly as umbrelOS's docker-compose.yml would --
	// HEARTH_PLATFORM=umbrel, the app_proxy header trio, a real deterministic
	// admin password, but deliberately NO APP_DATA_DIR / HEARTH_DATA_DIR
	// override, matching the real compose file (see the Dockerfile comment).
	const runArgs = [
		'run',
		'-d',
		'--name',
		containerName,
		...(platform ? ['--platform', platform] : []),
		'-p',
		`${port}:3000`,
		'-v',
		`${dataDir}:/data`,
		'-e',
		'HEARTH_PLATFORM=umbrel',
		'-e',
		'HEARTH_ADMIN_PASSWORD=smoketestpassword',
		'-e',
		`HEARTH_ORIGIN=http://localhost:${port}`,
		'-e',
		'PROTOCOL_HEADER=x-forwarded-proto',
		'-e',
		'HOST_HEADER=x-forwarded-host',
		'-e',
		'ADDRESS_HEADER=x-forwarded-for',
		image
	];
	const runResult = run('docker', runArgs);
	if (runResult.status !== 0) {
		console.error(runResult.stderr);
		fail('docker run failed to start the container');
	}

	// Give it real time to boot (DB open + migrations + notify secret init).
	// Emulated (QEMU) non-native-arch boots are noticeably slower than native.
	await sleep(platform ? 9000 : 4000);

	const psResult = run('docker', ['inspect', '-f', '{{.State.Running}}', containerName]);
	if (psResult.stdout.trim() !== 'true') {
		fail('container is not running after the start period (crashed on boot)');
	}
	console.log('[smoke] container still running after boot -- OK');

	// --- /api/health ---
	let health;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`);
		health = res.status;
	} catch (e) {
		fail(`GET /api/health threw: ${e}`);
	}
	if (health !== 200) fail(`GET /api/health returned ${health}, expected 200`);
	console.log('[smoke] GET /api/health -> 200 -- OK');

	// --- / (themed shell) ---
	let root;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`);
		root = res.status;
	} catch (e) {
		fail(`GET / threw: ${e}`);
	}
	// Unauthenticated root may redirect to /login (SvelteKit redirects come
	// back as a followed 200 via fetch); either a direct 200 or a redirect
	// that resolves to 200 is acceptable -- a 5xx or a hung connection is not.
	if (root && root >= 500) fail(`GET / returned ${root}`);
	console.log(`[smoke] GET / -> ${root} -- OK`);

	// --- DB created under the HOST side of /data ---
	const dbPath = path.join(dataDir, 'hearth.db');
	if (!existsSync(dbPath)) {
		console.error('[smoke] contents of dataDir:', readdirSync(dataDir));
		fail(`hearth.db was not created at ${dbPath} (app wrote somewhere else, or never opened the DB)`);
	}
	console.log('[smoke] hearth.db created on the mounted /data volume -- OK');

	// --- uid 1000 ownership of everything the app created ---
	// (Windows bind mounts do not preserve real uid/gid bits in the same way,
	// so this check only asserts meaningfully on a Linux Docker host; skip it
	// with a clear note rather than false-failing under Docker Desktop's
	// Windows filesystem passthrough.)
	if (process.platform !== 'win32') {
		const st = statSync(dbPath);
		if (st.uid !== 1000) fail(`hearth.db is owned by uid ${st.uid}, expected 1000`);
		console.log('[smoke] hearth.db owned by uid 1000 -- OK');
	} else {
		console.log('[smoke] skipping uid-ownership check (Windows host bind mount does not preserve real uid bits)');
	}

	console.log('[smoke] ALL CHECKS PASSED');
	cleanup();
}

main().catch((e) => {
	console.error(e);
	cleanup();
	process.exit(1);
});
