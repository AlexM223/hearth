/**
 * T0/T7/T8's devDependency-placement guard (SIGNING.md §0.4, §5.1). Every
 * signing-surface transport library MUST be a `devDependency`, never a
 * `dependency` -- they're present when `vite build` runs (which installs
 * devDeps) and tree-shaken into client bundles, but absent from the runtime
 * `node_modules`. This is what keeps `@trezor/connect-web`'s transitive
 * native `usb` addon (and, now, bitbox-api's WASM) out of the production
 * closure while still shipping.
 *
 * Stage 3 (hearth-ui7): `jadets` (live Jade over Web Serial) was assessed and
 * deliberately NOT installed -- unofficial/single-maintainer, ~11 months
 * without an npm release, and a confirmed unfixed bug in the exact
 * multi-chunk `signPSBT` response path it would need, reported independently
 * by a Caravan integrator attempting the same use case. `jadeUr.ts` (the
 * BC-UR/Keystone/Jade-QR animated-QR codec) is a hand-rolled, zero-runtime-
 * dependency module per SIGNING.md §1.7 -- it needs no entry here at all.
 * The ONE new library this stage adds is `qrcode`, purely to render an
 * arbitrary BC-UR frame string as a QR image for the "Show" half of
 * `SignWithQr.svelte` (bbqr's own renderer is BBQr-format-specific).
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

// Stage 2 (hearth-mhp): bitbox-api itself, plus the build plugins its WASM
// glue needs (vite-plugin-wasm). Both must stay devDependencies -- present
// for `vite build`'s client bundle, absent from the runtime image.
const STAGE2_TRANSPORT_LIBS = ['bitbox-api', 'vite-plugin-wasm'];

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
		// calls this same scanner). When build/ is absent the scanner reports
		// zero hits, so asserting unconditionally keeps vitest's
		// require-assertions rule satisfied (a guarded `if (scanned)` expect
		// failed CI's unit job, which never builds) without a false failure.
		const { hits } = scanBuiltServerBundle();
		expect(hits).toEqual([]);
	});
});

describe('T7: Stage-2 (BitBox02) libs are devDependencies, never dependencies', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

	for (const lib of STAGE2_TRANSPORT_LIBS) {
		it(`${lib} is a devDependency`, () => {
			expect(pkg.devDependencies?.[lib]).toBeTruthy();
		});
		it(`${lib} is NOT a production dependency`, () => {
			expect(pkg.dependencies?.[lib]).toBeUndefined();
		});
	}

	it('bitbox-api (a browser-only WASM package) stays out of the production closure', () => {
		const { nativeHits } = scanProductionClosure();
		// Not a "native .node" hit by definition (it's WASM, not a compiled
		// addon), but the closure walk only starts from `dependencies` at all --
		// this assertion is really about STAGE2_TRANSPORT_LIBS above (devDep,
		// not dep), re-confirmed here alongside the Stage-1 native-closure check
		// so a future change can't quietly move bitbox-api into `dependencies`
		// without this suite noticing via the two assertions above.
		expect(nativeHits).toEqual([]);
	});
});

// Stage 3 (hearth-ui7, re-scoped to BC-UR-only): `jadeUr.ts` itself needs no
// entry -- it's hand-rolled with zero new runtime dependencies. `qrcode`
// renders the BC-UR "Show" QR image and must follow the same devDep rule.
const STAGE3_TRANSPORT_LIBS = ['qrcode'];

describe('T8: Stage-3 (BC-UR QR) libs are devDependencies, never dependencies', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

	for (const lib of STAGE3_TRANSPORT_LIBS) {
		it(`${lib} is a devDependency`, () => {
			expect(pkg.devDependencies?.[lib]).toBeTruthy();
		});
		it(`${lib} is NOT a production dependency`, () => {
			expect(pkg.dependencies?.[lib]).toBeUndefined();
		});
	}

	it('jadets is NOT installed at all (Stage 3 live-Jade driver deliberately not built)', () => {
		expect(pkg.devDependencies?.jadets).toBeUndefined();
		expect(pkg.dependencies?.jadets).toBeUndefined();
	});

	it('qrcode (a pure-JS QR renderer) stays out of the production closure', () => {
		const { nativeHits } = scanProductionClosure();
		expect(nativeHits).toEqual([]);
	});
});
