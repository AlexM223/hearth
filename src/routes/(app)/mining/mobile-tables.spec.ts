/**
 * Regression test for hearth-71z (UX sweep finding #2, mobile audit): the
 * mining dashboard renders two real HTML `<table>`s (worker table, admin
 * miner table) with 5/4 columns of tabular-nums data. Unlike a flex row, a
 * `<table>` never reflows -- at a 375px viewport it forces the whole page
 * wider than the viewport (`document.body.scrollWidth > innerWidth`) unless
 * wrapped in its own horizontally-scrollable container. This mirrors the
 * proven `.matrix-scroll` pattern already shipped on
 * `/me/notifications/+page.svelte` rather than inventing a new one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('mining dashboard tables scroll horizontally in their own container instead of blowing out the page (hearth-71z)', () => {
	it('both <table>s are wrapped in a .table-scroll container', () => {
		const tableCount = (source.match(/<table>/g) ?? []).length;
		const wrappedCount = (source.match(/<div class="table-scroll">\s*<table>/g) ?? []).length;
		expect(tableCount).toBeGreaterThan(0); // vacuous-pass guard
		expect(wrappedCount).toBe(tableCount);
	});

	it('.table-scroll actually sets overflow-x: auto', () => {
		expect(source).toMatch(/\.table-scroll\s*\{\s*overflow-x:\s*auto;\s*\}/);
	});
});
