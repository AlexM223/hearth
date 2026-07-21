/**
 * T8 acceptance (MINING-ENGINE.md §8, §9.2) -- the M5 SHIP GATE. A thin
 * vitest wrapper around scripts/qa-mining.mjs (a standalone Node driver, run
 * via `tsx` so it can import hearth's TS modules directly with no SvelteKit
 * runtime). `describe.skipIf`s when neither a bitcoind binary nor Docker is
 * present, so `npm test` stays green and hermetic on a bare CI box; on a dev
 * machine with Docker (this one), it actually spins a regtest bitcoind,
 * drives the real engine end-to-end, and asserts `RESULT: PASS`.
 */
import { describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function dockerAvailable(): boolean {
	try {
		return spawnSync('docker', ['version'], { timeout: 5000 }).status === 0;
	} catch {
		return false;
	}
}

function bitcoindBinaryAvailable(): boolean {
	if (process.env.BITCOIND_PATH) return true;
	for (const p of ['/usr/bin/bitcoind', '/usr/local/bin/bitcoind', 'C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe']) {
		try {
			if (spawnSync(p, ['-version'], { timeout: 3000 }).status === 0) return true;
		} catch {
			/* not present */
		}
	}
	return false;
}

const HAVE_REGTEST_BACKEND = dockerAvailable() || bitcoindBinaryAvailable();

if (!HAVE_REGTEST_BACKEND) {
	process.stderr.write(
		'\n[forcedSolve.e2e] SKIPPED -- no Docker and no bitcoind binary found.\n' +
			'  Run directly: npx tsx scripts/qa-mining.mjs\n\n'
	);
}

describe.skipIf(!HAVE_REGTEST_BACKEND)('T8: forced-solve regtest harness (ship gate)', () => {
	it(
		'scripts/qa-mining.mjs exits 0 and prints RESULT: PASS',
		() => {
			const scriptPath = fileURLToPath(new URL('../../../../scripts/qa-mining.mjs', import.meta.url));
			let stdout = '';
			let status = 0;
			// execSync (a single shell command string), not execFileSync + an args
			// array, so this never hits Node's shell-plus-args escaping warning --
			// `scriptPath` is fully controlled (derived from import.meta.url), never
			// untrusted input, so building the command string here is safe.
			try {
				stdout = execSync(`npx tsx "${scriptPath}"`, {
					encoding: 'utf8',
					timeout: 5 * 60_000,
					windowsHide: true
				});
			} catch (e) {
				const err = e as { status?: number; stdout?: string; stderr?: string };
				status = err.status ?? 1;
				stdout = (err.stdout ?? '') + '\n' + (err.stderr ?? '');
			}
			if (!/RESULT: PASS/.test(stdout)) {
				process.stderr.write(stdout);
			}
			expect(status).toBe(0);
			expect(stdout).toMatch(/RESULT: PASS/);
		},
		6 * 60_000
	);
});
