/**
 * Regression test for hearth-i2x (UX sweep finding #6, Medium): the wiring
 * half of the fix. `theme.spec.ts` proves `$lib/theme.ts` itself behaves
 * correctly; this proves both controls that used to keep independent state
 * -- the header `ThemeToggle` and `/me`'s Display form -- actually route
 * through it now, and that `/me` reads the LIVE (localStorage) value on
 * mount per the sweep's own suggested fix, rather than only the
 * server-persisted `prefs.theme` row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const toggleSource = readFileSync(
	fileURLToPath(new URL('./components/ThemeToggle.svelte', import.meta.url)),
	'utf8'
);
const meSource = readFileSync(fileURLToPath(new URL('../routes/(app)/me/+page.svelte', import.meta.url)), 'utf8');

describe('ThemeToggle and /me route through the single $lib/theme implementation (hearth-i2x)', () => {
	it('ThemeToggle applies locally AND mirrors to the server on every change', () => {
		expect(toggleSource).toContain("from '$lib/theme.js'");
		expect(toggleSource).toContain('applyThemeLocally(next)');
		expect(toggleSource).toContain('mirrorThemeToServer(next)');
	});

	it('/me overrides its SSR-seeded theme with the live localStorage value on mount', () => {
		expect(meSource).toContain("from '$lib/theme.js'");
		expect(meSource).toMatch(/onMount\(\(\) => \{\s*liveTheme = readStoredTheme\(\);/);
	});

	it('/me applies the choice locally (localStorage + data-theme) the instant the form is submitted, not just server-side', () => {
		expect(meSource).toContain('applyThemeLocally(liveTheme)');
	});

	it('/me\'s radio group is bound to the same liveTheme state it seeds from localStorage (not a separate server-only value)', () => {
		expect(meSource).toMatch(/bind:group=\{liveTheme\}/);
	});
});
