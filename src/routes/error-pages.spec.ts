/**
 * Regression test for hearth-2hi (UX sweep finding #1): before this fix, NO
 * `+error.svelte` existed anywhere in the app, so every error -- an unknown
 * route, a 404 wallet, a 500 -- fell back to SvelteKit's bare unstyled
 * default (`<h1>404</h1><p>wallet not found</p>`, no Ingle tokens, no brand
 * voice). This is a source-level assertion (no component-test harness in
 * this repo -- see mining/keyed-lists.spec.ts) that both error boundaries
 * exist, are themed, and speak in Hearth's warm voice rather than a raw
 * status code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appError = fileURLToPath(new URL('./(app)/+error.svelte', import.meta.url));
const rootError = fileURLToPath(new URL('./+error.svelte', import.meta.url));

describe('branded error boundaries exist (hearth-2hi)', () => {
	it('the (app)-group error page exists and keeps the shared layout (no full-page takeover markup)', () => {
		const source = readFileSync(appError, 'utf8');
		expect(source).toContain("import { page } from '$app/state'");
		expect(source).toContain('panel');
		// Deliberately does NOT re-render the brand/header -- (app)/+layout.svelte
		// already wraps it, so a second header here would double up.
		expect(source).not.toContain('ThemeToggle');
	});

	it('the root error page exists and is a fully standalone branded page (join/[code] tone template)', () => {
		const source = readFileSync(rootError, 'utf8');
		expect(source).toContain("import { page } from '$app/state'");
		expect(source).toContain('ThemeToggle');
		expect(source).toContain('badge-no-cloud');
	});

	for (const [name, path] of [
		['(app)', appError],
		['root', rootError]
	] as const) {
		it(`${name} error page never surfaces a bare "Not Found" / raw status code as the headline`, () => {
			const source = readFileSync(path, 'utf8');
			// The bare SvelteKit default renders literally `{$page.status}` as the
			// only heading text with no other copy -- guard against reverting to that.
			expect(source).not.toMatch(/<h1>\{[^}]*status[^}]*\}<\/h1>/);
			expect(source).toContain('btn-primary');
			expect(source).toMatch(/Back home/);
		});

		it(`${name} error page distinguishes 404 vs 500 vs a generic status with different copy`, () => {
			const source = readFileSync(path, 'utf8');
			expect(source).toMatch(/status === 404/);
			expect(source).toMatch(/status >= 500/);
		});
	}
});
