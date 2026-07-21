/**
 * T0 acceptance (WATCHTOWER.md §0.3): "T0 re-exports these [SPV primitives]
 * from wallet/index.ts; notify/ imports them from $lib/server/wallet and
 * adds NO merkle/PoW code of its own." Two static checks, kept green as the
 * module grows through T1-T8:
 *
 *  1. wallet/index.ts's public surface actually re-exports verifyTxInclusion
 *     + bitsToTarget (the reuse boundary has to be reachable, not just
 *     promised in a comment).
 *  2. No file under notify/** re-implements a merkle/PoW primitive (by name)
 *     -- difficulty.ts (T1) and detect/watcher.ts (T1) must call the wallet
 *     module's functions, never redefine them.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as walletSurface from '../wallet/index.js';

const NOTIFY_DIR = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...listSourceFiles(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
			out.push(full);
		}
	}
	return out;
}

// Names that must never be (re)DEFINED under notify/** -- only imported.
const RESERVED_PRIMITIVE_NAMES = [
	'verifyTxInclusion',
	'bitsToTarget',
	'parseBlockHeader',
	'meetsTarget',
	'computeMerkleRoot',
	'parseHeader',
	'sha256d'
];

describe('T0/T1: SPV is reused from wallet/, never re-implemented in notify/', () => {
	it('wallet/index.ts re-exports verifyTxInclusion + bitsToTarget + parseBlockHeader + meetsTarget (the reuse boundary is reachable)', () => {
		expect(typeof walletSurface.verifyTxInclusion).toBe('function');
		expect(typeof walletSurface.bitsToTarget).toBe('function');
		expect(typeof walletSurface.parseBlockHeader).toBe('function');
		expect(typeof walletSurface.meetsTarget).toBe('function');
	});

	it('no file under notify/** defines a merkle/PoW primitive of its own', () => {
		const files = listSourceFiles(NOTIFY_DIR);
		const offenders: string[] = [];
		for (const file of files) {
			const src = readFileSync(file, 'utf8');
			for (const name of RESERVED_PRIMITIVE_NAMES) {
				// Matches `function name(`, `const name =`, `export function name(` etc.
				// -- a DEFINITION, not a call (`name(` alone would false-positive on
				// legitimate calls to the imported function).
				const defPattern = new RegExp(`\\b(function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`);
				if (defPattern.test(src)) offenders.push(`${file}: defines ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
