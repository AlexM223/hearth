/**
 * The no-native-deps guard as a Vitest gate (DECISIONS.md §2, §5.1). The M2
 * crypto deps (@scure/*, @noble/hashes, bitcoinjs-lib) must all be pure JS/WASM
 * -- this fails the build if any production dependency ships a compiled `.node`
 * addon or a binding.gyp (the cairn `usb`-via-`@trezor/connect-web` lesson).
 */
import { describe, expect, it } from 'vitest';
import { scanProductionClosure } from '../../../scripts/check-no-native-deps.mjs';

describe('no-native-deps guard (production closure)', () => {
	it('finds zero native addons in the production dependency tree', () => {
		const { packagesScanned, nativeHits } = scanProductionClosure();
		expect(packagesScanned).toBeGreaterThan(0);
		expect(nativeHits).toEqual([]);
	});
});
