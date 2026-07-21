/**
 * The constitutional test (WALLET-ENGINE §6.3; DECISIONS.md §0.3 rule 3, §4.2).
 * Heartwood had THREE broadcast entry points in its wallet layer. Hearth has
 * ONE. This static test greps the wallet engine tree for calls into the
 * broadcast rail and asserts they occur in exactly ONE module -- broadcast.ts --
 * at exactly ONE call site. Any second occurrence fails the build.
 *
 * Scope note (documented deviation from the spec's literal "grep all of
 * src/lib/server/**"): the broadcast PRIMITIVE legitimately lives in the node
 * rail (src/lib/server/node/index.ts: NodeClient.broadcast -> electrum/Core),
 * and the electrum client/pool carry the wire method DEFINITION. Those are the
 * driver, not duplicate spend paths. The bug class Heartwood shipped -- multiple
 * broadcast ENTRY POINTS in the wallet engine -- is exactly what this test pins
 * to one call site in the wallet tree.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const walletDir = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
	}
	return out;
}

/** Strip // and block comments so prose mentioning `node.broadcast(` never
 *  counts as a call site. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Call tokens that reach the broadcast rail (calls, not method definitions).
const RAIL_CALL = /\b(?:node|this\.node|rail)\.broadcast\s*\(|sendrawtransaction|broadcast_package|submitpackage/;

describe('constitutional: exactly one broadcast path in the wallet engine', () => {
	const files = walk(walletDir);

	it('only broadcast.ts contains a broadcast-rail call', () => {
		const offenders: string[] = [];
		for (const f of files) {
			const src = stripComments(readFileSync(f, 'utf8'));
			if (RAIL_CALL.test(src) && !f.endsWith('broadcast.ts')) {
				offenders.push(f);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('broadcast.ts reaches the rail at exactly one call site', () => {
		const src = stripComments(readFileSync(join(walletDir, 'broadcast.ts'), 'utf8'));
		const calls = src.match(/node\.broadcast\s*\(/g) ?? [];
		expect(calls.length).toBe(1);
	});

	it('no wallet-engine file signs, imports a seed API, or imports an hw transport (§5.1)', () => {
		// The server NEVER holds or uses a private key. `.privateKey` is permitted
		// ONLY in derive.ts, where it is a REJECTION guard (throw if a private
		// extended key was supplied) -- never key use.
		const bannedUse = /from ['"]@ledgerhq|from ['"]@trezor|from ['"]bbqr|from ['"].*\/hw\/|mnemonicTo|fromMnemonic|\bsignIdx\s*\(|(?<!engine)\.sign\s*\(|\bWIF\b/;
		const offenders: string[] = [];
		for (const f of files) {
			const src = stripComments(readFileSync(f, 'utf8'));
			if (bannedUse.test(src)) offenders.push(f + ' (signing/seed/hw)');
			if (/\.privateKey\b/.test(src) && !f.endsWith('derive.ts')) {
				offenders.push(f + ' (privateKey outside the reject-guard)');
			}
		}
		expect(offenders).toEqual([]);
	});
});
