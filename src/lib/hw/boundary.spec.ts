/**
 * The signing-surface boundary invariant (SIGNING.md §0.3, §5.1): no file
 * under `src/lib/hw/**` or `src/lib/components/sign/**` imports from
 * `$lib/server` (or a relative `../server` path) -- these directories are
 * BROWSER-SIDE ONLY. The only data crossing the trust boundary is base64
 * PSBT strings over the existing HTTP routes; a "device driver bug" must
 * never gain server-code access.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HW_DIR = dirname(fileURLToPath(import.meta.url));
const SIGN_COMPONENTS_DIR = join(HW_DIR, '..', 'components', 'sign');

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
		else if ((entry.endsWith('.ts') || entry.endsWith('.svelte')) && !entry.endsWith('.spec.ts')) out.push(full);
	}
	return out;
}

function findServerImports(files: string[]): string[] {
	const offenders: string[] = [];
	const SERVER_IMPORT = /from\s+['"](\$lib\/server[^'"]*|\.\.\/server[^'"]*|\.\.\/\.\.\/server[^'"]*)['"]/;
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		const importLines = src.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
		for (const line of importLines) {
			if (SERVER_IMPORT.test(line)) offenders.push(`${file}: ${line.trim()}`);
		}
	}
	return offenders;
}

describe('T0: signing-surface boundary -- src/lib/hw/** never imports $lib/server', () => {
	it('no file under src/lib/hw/** imports server code', () => {
		expect(findServerImports(listSourceFiles(HW_DIR))).toEqual([]);
	});

	it('no file under src/lib/components/sign/** imports server code', () => {
		expect(findServerImports(listSourceFiles(SIGN_COMPONENTS_DIR))).toEqual([]);
	});

	it('at least the driver files actually exist (a passing empty-glob would be a false green)', () => {
		const files = listSourceFiles(HW_DIR);
		const names = files.map((f) => f.split(/[/\\]/).pop());
		for (const expected of ['common.ts', 'secureContext.ts', 'psbtFile.ts', 'bbqr.ts', 'qrScan.ts', 'ledger.ts', 'trezor.ts', 'bitbox02.ts', 'jadeUr.ts']) {
			expect(names).toContain(expected);
		}
	});
});
