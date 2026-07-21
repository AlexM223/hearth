/**
 * Run the regtest e2e suites the way they are safe to run: SEQUENTIALLY.
 *
 * All three suites share the ONE regtest bitcoind (see each spec's header for
 * the docker run line) -- vitest's default per-file parallelism lets the
 * mining suite mine blocks in the middle of the wallet suite's SPV-verify
 * step, which fails it flakily. --no-file-parallelism serializes the files;
 * HEARTH_E2E=1 un-skips them.
 *
 *   npm run test:e2e
 */
import { spawnSync } from 'node:child_process';

const files = [
	'src/lib/server/wallet/wallet.regtest.e2e.spec.ts',
	'src/lib/server/notify/watchtower.regtest.e2e.spec.ts',
	'src/lib/server/mining/forcedSolve.e2e.spec.ts'
];

const result = spawnSync('npx', ['vitest', 'run', '--no-file-parallelism', ...files], {
	env: { ...process.env, HEARTH_E2E: '1' },
	stdio: 'inherit',
	shell: process.platform === 'win32'
});
process.exit(result.status ?? 1);
