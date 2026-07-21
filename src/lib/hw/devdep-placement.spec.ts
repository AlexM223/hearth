/**
 * T0's devDependency-placement guard (SIGNING.md §0.4, §5.1). The signing
 * surface's Stage-1 transport libraries MUST be `devDependencies`, never
 * `dependencies` -- they're present when `vite build` runs (which installs
 * devDeps) and tree-shaken into client bundles, but absent from the runtime
 * `node_modules`. This is what keeps `@trezor/connect-web`'s transitive
 * native `usb` addon out of the production closure while still shipping.
 *
 * Stage 2/3 libs (bitbox-api, jadets) are filed as future work
 * (hearth-mhp/hearth-ui7), not installed -- only the Stage-1 six are
 * asserted here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProductionClosure, scanBuiltServerBundle } from '../../../scripts/check-no-native-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const STAGE1_TRANSPORT_LIBS = [
	'@ledgerhq/hw-transport-webhid',
	'@ledgerhq/hw-app-btc',
	'@ledgerhq/psbtv2',
	'buffer',
	'@trezor/connect-web',
	'bbqr'
];

describe('T0: Stage-1 transport libs are devDependencies, never dependencies', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

	for (const lib of STAGE1_TRANSPORT_LIBS) {
		it(`${lib} is a devDependency`, () => {
			expect(pkg.devDependencies?.[lib]).toBeTruthy();
		});
		it(`${lib} is NOT a production dependency`, () => {
			expect(pkg.dependencies?.[lib]).toBeUndefined();
		});
	}

	it("Trezor's transitive native `usb` stays out of the production closure", () => {
		const { nativeHits } = scanProductionClosure();
		expect(nativeHits).toEqual([]);
	});

	it('the built server bundle (build/) contains no .node file, when built', () => {
		// Best-effort: this fast unit suite doesn't itself trigger `vite build`
		// (CI's separate build step does, then re-runs `check:native`, which
		// calls this same scanner). If build/ isn't present, this is a no-op
		// rather than a false failure/false green.
		const { scanned, hits } = scanBuiltServerBundle();
		if (scanned) expect(hits).toEqual([]);
	});
});
