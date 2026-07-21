/**
 * Regression test for hearth-2ll (UX sweep finding #9, Low): the light-theme
 * `--text-hero` token (`#14161a`) was byte-for-byte identical to dark
 * theme's `--bg` value -- a copy-paste artifact, not a value derived from
 * the light-mode ink scale (`--text: #20242a` per DECISIONS.md §3). No
 * visible harm (contrast was actually strong), but it read as unintentional.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');

function tokenValues(varName: string): string[] {
	const re = new RegExp(`${varName}:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
	return [...css.matchAll(re)].map((m) => m[1]!.toLowerCase());
}

describe('light-theme --text-hero is a deliberate ink-scale derivation, not the dark --bg value (hearth-2ll)', () => {
	it('dark --bg stays #14161a (unchanged reference point)', () => {
		expect(tokenValues('--bg')[0]).toBe('#14161a');
	});

	it('every light-theme --text-hero declaration is no longer #14161a', () => {
		const heroValues = tokenValues('--text-hero');
		expect(heroValues.length).toBeGreaterThanOrEqual(3); // dark + [data-theme=light] + the system-light @media block
		for (const v of heroValues) {
			if (v === '#f5f0e6') continue; // dark theme's own (correct, unrelated) value
			expect(v).not.toBe('#14161a');
		}
	});

	it('the [data-theme="light"] block and the system-light @media block agree with each other', () => {
		const heroValues = tokenValues('--text-hero');
		// [dark, light-data-theme, system-media] in source order.
		expect(heroValues[1]).toBe(heroValues[2]);
	});

	it('light-mode --text-hero is darker than --text (a real hero derivation, not an arbitrary color)', () => {
		const textHero = tokenValues('--text-hero')[1]!; // the [data-theme='light'] block
		const text = tokenValues('--text')[0]!; // light theme's first --text declaration
		const toRgb = (hex: string) => {
			const n = parseInt(hex.slice(1), 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		};
		const [hr, hg, hb] = toRgb(textHero);
		const [tr, tg, tb] = toRgb(text);
		// Darker on every channel -- "a touch richer/darker than --text".
		expect(hr).toBeLessThanOrEqual(tr);
		expect(hg).toBeLessThanOrEqual(tg);
		expect(hb).toBeLessThanOrEqual(tb);
	});
});
