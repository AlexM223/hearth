/**
 * Regression test for hearth-i2x (UX sweep finding #6, Medium) and its
 * hearth-7w6 follow-up. `theme.spec.ts` proves `$lib/theme.svelte.ts` itself
 * behaves correctly; this proves both controls that used to keep independent
 * state -- the header `ThemeToggle` and `/me`'s Display form -- actually
 * route through it now, that `/me` reads the LIVE shared theme value on
 * mount per the sweep's own suggested fix (rather than only the
 * server-persisted `prefs.theme` row), and that `ThemeToggle` reads that same
 * shared source REACTIVELY (`$derived`), not just once at mount (hearth-7w6:
 * a plain one-shot `$state` seed left the header showing a stale label after
 * /me changed the theme without a reload, since the header component never
 * remounts on client-side navigation).
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
		expect(toggleSource).toContain("from '$lib/theme.svelte.js'");
		expect(toggleSource).toContain('applyThemeLocally(next)');
		expect(toggleSource).toContain('mirrorThemeToServer(next)');
	});

	it('ThemeToggle (hearth-7w6) derives its displayed label from the shared reactive getTheme(), not a one-shot local $state seed', () => {
		expect(toggleSource).toContain('import {\n\t\tgetTheme,');
		expect(toggleSource).toMatch(/let choice = \$derived\(getTheme\(\)\);/);
		// The old bug: seeding `choice` once from readStoredTheme() into a
		// plain $state and never updating it except on this component's own
		// clicks. Assert that pattern is gone (as actual code, not just absent
		// from the explanatory comment above, which still mentions it).
		expect(toggleSource).not.toMatch(/let choice = \$state/);
	});

	it('/me overrides its SSR-seeded theme with the live shared theme value on mount', () => {
		expect(meSource).toContain("from '$lib/theme.svelte.js'");
		expect(meSource).toMatch(/onMount\(\(\) => \{\s*liveTheme = getTheme\(\);/);
	});

	it('/me applies the choice locally (localStorage + data-theme) the instant the form is submitted, not just server-side', () => {
		expect(meSource).toContain('applyThemeLocally(liveTheme)');
	});

	it('/me\'s radio group is bound to the same liveTheme state it seeds from localStorage (not a separate server-only value)', () => {
		expect(meSource).toMatch(/bind:group=\{liveTheme\}/);
	});
});
