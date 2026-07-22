/**
 * The cross-module public-surface boundary invariant (DECISIONS.md §4.1): a
 * file in one top-level `src/lib/server/<module>/` directory may reach a
 * SIBLING module only through that sibling's `index.ts` -- never by importing
 * one of the sibling's own internal files directly (e.g. `chain/*.ts` must
 * import Core RPC helpers from `../node/index.js`, never `../node/core/rpc.js`
 * or `../node/electrum/client.js`). This is the same "public surface only"
 * shape as hw/boundary.spec.ts's browser/server split, just enforced between
 * sibling server modules instead of between browser and server.
 *
 * `db`, `config`, `events`, and the top-level `log.ts` are shared utility
 * surfaces every module already reaches via their own index.ts (or `log.js`
 * directly, which has no submodules to bypass) -- this mirrors the
 * codebase's existing universal convention of `../db/index.js`,
 * `../config/index.js`, `../events/index.js`.
 *
 * Within-module relative imports -- including a module's own nested
 * submodules, e.g. `notify/channels/*.ts` importing `notify/config/*.ts`,
 * still inside `notify/` -- are unrestricted; only CROSS-module boundaries
 * are checked. `.spec.ts` files are excluded from the scan (tests reach into
 * internals on purpose to construct fakes/mocks).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Files exempt from the boundary rule. Empty today; add entries only with a bead reference. */
const TEMP_ALLOWLIST = new Set<string>([]);

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
	}
	return out;
}

/** The top-level module a file lives under, e.g. `chain`, `mining`, `node` --
 *  or `null` for a file directly in `src/lib/server/` (shared, e.g. log.ts). */
function moduleOf(file: string): string | null {
	const rel = relative(SERVER_DIR, file);
	const parts = rel.split(sep);
	return parts.length > 1 ? parts[0] : null;
}

/**
 * Pure checker: given one file's absolute path and its source text, returns
 * every import line that reaches past a sibling module's index.ts. Kept
 * side-effect-free (no disk I/O) so the "would have caught the historical
 * bug" test below can feed it synthetic source text directly.
 */
function findViolationsInSource(file: string, src: string): string[] {
	const ownModule = moduleOf(file);
	if (!ownModule) return []; // shared top-level files (log.ts) impose no rule on others
	if (TEMP_ALLOWLIST.has(file)) return [];

	const offenders: string[] = [];
	const IMPORT_RE = /^\s*import[\s\S]*?from\s+['"]([^'"]+)['"];?/gm;
	let match: RegExpExecArray | null;
	while ((match = IMPORT_RE.exec(src))) {
		const importPath = match[1];
		if (!importPath.startsWith('../')) continue; // same-module-root, external, or alias import: fine

		// Resolve relative to the FILE (not the module root) -- files can be
		// nested (e.g. notify/channels/email.ts's '../config/...' means
		// notify/config/, not server/config/).
		const resolved = join(dirname(file), ...importPath.split('/'));
		const relFromServer = relative(SERVER_DIR, resolved).split(sep);
		const targetModule = relFromServer[0];

		if (targetModule.startsWith('..')) continue; // escapes src/lib/server entirely (e.g. src/lib/shared/*): not a server-module boundary concern
		if (targetModule === ownModule) continue; // same top-level module: fine, any depth
		if (relFromServer.length === 1) continue; // e.g. '../log.js' -- a shared top-level file, not a module dir

		// Crossing into a sibling module's directory: only its own index.(t|j)s is allowed.
		const entryName = relFromServer[1].replace(/\.(js|ts)$/, '');
		const isIndexEntry = relFromServer.length === 2 && entryName === 'index';
		if (!isIndexEntry) {
			offenders.push(importPath);
		}
	}
	return offenders;
}

function findBoundaryViolations(files: string[]): Array<{ file: string; importPath: string }> {
	const offenders: Array<{ file: string; importPath: string }> = [];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		for (const importPath of findViolationsInSource(file, src)) {
			offenders.push({ file, importPath });
		}
	}
	return offenders;
}

describe('DECISIONS.md §4.1: cross-module server imports go through index.ts only', () => {
	it('no src/lib/server/*/** file reaches past a sibling module index.ts', () => {
		const files = listSourceFiles(SERVER_DIR);
		const violations = findBoundaryViolations(files);
		const formatted = violations.map(
			(v) => `${relative(SERVER_DIR, v.file)}: import ... from '${v.importPath}'`
		);
		expect(formatted).toEqual([]);
	});

	it('the scan actually walks real files (a passing empty-glob would be a false green)', () => {
		const files = listSourceFiles(SERVER_DIR);
		const names = files.map((f) => f.split(/[/\\]/).pop());
		for (const expected of ['index.ts', 'blocks.ts', 'tx.ts', 'address.ts']) {
			expect(names).toContain(expected);
		}
		expect(files.length).toBeGreaterThan(30);
	});

	it('would have failed on the pre-fix tree: chain/*.ts importing node/core/rpc.js or node/electrum/client.js directly', () => {
		const blocksFile = join(SERVER_DIR, 'chain', 'blocks.ts');
		const historicalSrc = `import { getBlock, type RpcCaller } from '../node/core/rpc.js';\n`;
		expect(findViolationsInSource(blocksFile, historicalSrc)).toEqual(['../node/core/rpc.js']);

		const addressFile = join(SERVER_DIR, 'chain', 'address.ts');
		const historicalElectrumSrc = `import type { ElectrumBalance } from '../node/electrum/client.js';\n`;
		expect(findViolationsInSource(addressFile, historicalElectrumSrc)).toEqual([
			'../node/electrum/client.js'
		]);

		const miningFile = join(SERVER_DIR, 'mining', 'index.ts');
		const historicalWalletSrc = `import type { ChainNetwork } from '../wallet/types.js';\n`;
		expect(findViolationsInSource(miningFile, historicalWalletSrc)).toEqual(['../wallet/types.js']);
	});

	it('allows the sanctioned index.ts-only surface (no false positives)', () => {
		const blocksFile = join(SERVER_DIR, 'chain', 'blocks.ts');
		const fixedSrc = `import { getBlock, type RpcCaller } from '../node/index.js';\n`;
		expect(findViolationsInSource(blocksFile, fixedSrc)).toEqual([]);

		const miningFile = join(SERVER_DIR, 'mining', 'index.ts');
		const fixedWalletSrc = `import type { ChainNetwork } from '../wallet/index.js';\n`;
		expect(findViolationsInSource(miningFile, fixedWalletSrc)).toEqual([]);

		// Same-module nesting (e.g. notify/channels reaching notify/config) stays legal.
		const notifyChannelFile = join(SERVER_DIR, 'notify', 'channels', 'email.ts');
		const sameModuleSrc = `import { getUserChannelConfig } from '../config/channelConfig.js';\n`;
		expect(findViolationsInSource(notifyChannelFile, sameModuleSrc)).toEqual([]);

		// Shared top-level log.ts stays reachable directly (no index.ts to route through).
		const chainFile = join(SERVER_DIR, 'chain', 'snapshot.ts');
		const sharedLogSrc = `import { logWarn } from '../log.js';\n`;
		expect(findViolationsInSource(chainFile, sharedLogSrc)).toEqual([]);
	});
});
