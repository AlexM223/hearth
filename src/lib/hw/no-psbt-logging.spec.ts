/**
 * The no-PSBT-logging hard rule (SIGNING.md §3.4). No log line anywhere in
 * the sign/broadcast path -- server routes, the wallet engine, or the
 * browser-side drivers -- may include the `psbt` field, a signed-transaction
 * hex/base64, or recipient/amount detail. A draft/wallet/draft id is fine;
 * the transaction CONTENTS are not. `console.warn` diagnostics for a parse
 * FAILURE are allowed (cairn's own discipline) as long as they don't
 * interpolate the actual bytes -- this test flags any logging call whose
 * argument list mentions `psbt`/`signedPsbt` by name at all, which is a
 * strictly tighter bar that also catches that case, since a failure log can
 * describe the problem without ever naming the variable holding the bytes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const TARGET_DIRS = [
	join(REPO_ROOT, 'src', 'lib', 'hw'),
	join(REPO_ROOT, 'src', 'lib', 'components', 'sign'),
	join(REPO_ROOT, 'src', 'lib', 'server', 'wallet'),
	join(REPO_ROOT, 'src', 'routes', 'api', 'wallets')
];

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

/** Logging call sites: console.log/warn/error/debug, or this repo's own
 *  log()/logWarn()/logError() helpers. */
const LOG_CALL_RE = /\b(console\.(?:log|warn|error|debug|info)|logWarn|logError|log)\s*\(/g;

/** Extract a call's full argument-list text via balanced-paren matching,
 *  starting just after the opening `(` found by LOG_CALL_RE. */
function extractCallArgs(src: string, openParenIndex: number): string {
	let depth = 1;
	let i = openParenIndex + 1;
	for (; i < src.length && depth > 0; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') depth--;
	}
	return src.slice(openParenIndex + 1, i - 1);
}

const PSBT_ARG = /\bpsbt\b|signedpsbt|\.psbt\b/i;

function findPsbtLoggingOffenders(files: string[]): string[] {
	const offenders: string[] = [];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		let m: RegExpExecArray | null;
		LOG_CALL_RE.lastIndex = 0;
		while ((m = LOG_CALL_RE.exec(src))) {
			const openParen = m.index + m[0].length - 1;
			const args = extractCallArgs(src, openParen);
			if (PSBT_ARG.test(args)) {
				offenders.push(`${file}: ${m[0]}${args.slice(0, 80)}`);
			}
		}
	}
	return offenders;
}

describe('T0: no PSBT bytes ever reach a log line (SIGNING.md §3.4)', () => {
	it('no logging call in hw/, sign/ components, the wallet engine, or the drafts routes references psbt/signedPsbt', () => {
		const files = TARGET_DIRS.flatMap(listSourceFiles);
		expect(findPsbtLoggingOffenders(files)).toEqual([]);
	});

	it("server.mjs's access log never mentions psbt (method/path/status/ms only)", () => {
		const src = readFileSync(join(REPO_ROOT, 'server.mjs'), 'utf8');
		expect(/psbt/i.test(src)).toBe(false);
	});
});
