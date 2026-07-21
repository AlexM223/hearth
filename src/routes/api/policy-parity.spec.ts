/**
 * T2 acceptance (COME-ABOARD.md §7.1, §8): "policy/handler parity" -- every
 * `+server.ts` under src/routes/api MUST resolve to a non-null API_POLICY
 * rule for each HTTP method it exports. This is the other half of
 * deny-by-default (auth/policy.spec.ts already proves an UNMAPPED path
 * resolves to null); this proves no REAL, existing route is accidentally
 * unmapped and would 403 for every role including Owner.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveApiPolicy } from '$lib/server/auth/policy.js';

const API_ROOT = dirname(fileURLToPath(import.meta.url)); // src/routes/api

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else if (entry === '+server.ts') {
			out.push(full);
		}
	}
	return out;
}

/** "src/routes/api/wallets/[id]/drafts/[draftId]/+server.ts" -> "/api/wallets/1/drafts/2" */
function toPathname(filePath: string): string {
	const rel = filePath
		.slice(API_ROOT.length)
		.replace(/\\/g, '/')
		.replace(/\/\+server\.ts$/, '');
	const withPlaceholders = rel.replace(/\[([a-zA-Z]+)\]/g, '1');
	return `/api${withPlaceholders}`;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function exportedMethods(source: string): string[] {
	return HTTP_METHODS.filter((m) =>
		new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b`).test(source)
	);
}

describe('T2: API_POLICY / route-tree parity (deny-by-default has no accidental holes)', () => {
	const files = walk(API_ROOT);

	it('found at least the known M1/M2 route files (sanity check on the walker)', () => {
		expect(files.length).toBeGreaterThanOrEqual(9);
	});

	for (const file of files) {
		const pathname = toPathname(file);
		const source = readFileSync(file, 'utf8');
		const methods = exportedMethods(source);

		for (const method of methods) {
			it(`${method} ${pathname} resolves to a policy rule (not accidentally unmapped)`, () => {
				const rule = resolveApiPolicy(pathname, method);
				expect(rule).not.toBeNull();
			});
		}
	}

	it('an unmapped synthetic path still denies by default (the negative case)', () => {
		expect(resolveApiPolicy('/api/__unmapped', 'GET')).toBeNull();
	});
});
