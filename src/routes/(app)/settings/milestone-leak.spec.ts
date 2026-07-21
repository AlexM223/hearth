/**
 * Regression test for hearth-26z (UX sweep finding #8, Low): the Settings
 * page told end users "...will live here starting in M4" -- "M4" is an
 * internal build-order label from DECISIONS.md §6, meaningless to any user
 * (including an Owner who never read the constitution).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Only the user-visible markup matters here -- the file's own dev-facing
// script comment ("M4/M6 shells") is fine to keep; it's never rendered.
const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');
const markup = source.slice(source.indexOf('</script>'));

describe('Settings page copy never leaks an internal milestone code (hearth-26z)', () => {
	it('does not mention "M4" (or any bare milestone code) in user-visible markup', () => {
		expect(markup).not.toMatch(/\bM[0-9]\b/);
	});

	it('says the feature is coming soon instead', () => {
		expect(markup).toContain('coming soon');
	});
});
