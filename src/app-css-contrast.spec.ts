/**
 * Regression test for hearth-de0 (UX sweep finding #10, Low): light-theme
 * `--accent` (`#b5772e`) against `--on-accent` (`#fff8ef`) computed to
 * ~3.5:1 -- under WCAG AA's 4.5:1 floor for normal text, and the primary
 * button's 15px/600 label doesn't qualify for the large-text 3:1 exception.
 * DECISIONS.md §3 explicitly calls the light accent "darkened for AA", so
 * this was a shortfall against the file's own stated intent, not just a
 * generic a11y nice-to-have.
 *
 * Also covers hearth-2zt, the follow-up hearth-de0 explicitly spawned:
 * `--accent-hover` was left at its pre-fix lightness and collapsed to
 * ~2.94:1 once rest got darkened (hover used to be lighter than rest;
 * lighter doesn't clear AA once rest is already near the floor), and
 * `--accent-pressed` sat almost byte-identical to rest. Both now step
 * darker than rest in the same H32 hue family.
 *
 * This computes REAL WCAG relative-luminance contrast from the actual
 * token values in app.css (not a source-string guess), so it fails again if
 * the token ever regresses back toward the old value.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');

function tokenValues(varName: string): string[] {
	const re = new RegExp(`${varName}:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
	return [...css.matchAll(re)].map((m) => m[1]!.toLowerCase());
}

function relLuminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
	const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
}

const WCAG_AA_NORMAL_TEXT = 4.5;

describe('light-theme primary button meets WCAG AA text contrast (hearth-de0)', () => {
	it('--accent is no longer the old #b5772e value that computed to ~3.53:1', () => {
		const accentValues = tokenValues('--accent');
		// [dark, light-data-theme, system-light] in source order.
		expect(accentValues[1]).not.toBe('#b5772e');
		expect(accentValues[2]).not.toBe('#b5772e');
	});

	it('--accent vs --on-accent clears 4.5:1 in both light-theme declarations', () => {
		const accentValues = tokenValues('--accent');
		const onAccentValues = tokenValues('--on-accent');
		// index 1 = [data-theme='light'], index 2 = the system-light @media block
		for (const i of [1, 2]) {
			const ratio = contrastRatio(accentValues[i]!, onAccentValues[i]!);
			expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
		}
	});

	it('the [data-theme="light"] block and the system-light @media block agree on --accent', () => {
		const accentValues = tokenValues('--accent');
		expect(accentValues[1]).toBe(accentValues[2]);
	});

	it('dark theme is untouched and still comfortably clears AA (regression guard on the fix above)', () => {
		const accentValues = tokenValues('--accent');
		const onAccentValues = tokenValues('--on-accent');
		expect(accentValues[0]).toBe('#e6ad6b');
		expect(contrastRatio(accentValues[0]!, onAccentValues[0]!)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
	});
});

describe('light-theme hover/pressed accent states meet WCAG AA text contrast (hearth-2zt)', () => {
	it('--accent-hover is no longer the old #c48540 value that computed to ~2.94:1', () => {
		const hoverValues = tokenValues('--accent-hover');
		// [dark, light-data-theme, system-light] in source order.
		expect(hoverValues[1]).not.toBe('#c48540');
		expect(hoverValues[2]).not.toBe('#c48540');
	});

	it('--accent-hover vs --on-accent clears 4.5:1 in both light-theme declarations', () => {
		const hoverValues = tokenValues('--accent-hover');
		const onAccentValues = tokenValues('--on-accent');
		for (const i of [1, 2]) {
			const ratio = contrastRatio(hoverValues[i]!, onAccentValues[i]!);
			expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
		}
	});

	it('--accent-pressed vs --on-accent clears 4.5:1 in both light-theme declarations', () => {
		const pressedValues = tokenValues('--accent-pressed');
		const onAccentValues = tokenValues('--on-accent');
		for (const i of [1, 2]) {
			const ratio = contrastRatio(pressedValues[i]!, onAccentValues[i]!);
			expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
		}
	});

	it('hover and pressed both read as visibly darker than resting --accent, not near-duplicates', () => {
		const accentValues = tokenValues('--accent');
		const hoverValues = tokenValues('--accent-hover');
		const pressedValues = tokenValues('--accent-pressed');
		for (const i of [1, 2]) {
			const restLum = relLuminance(accentValues[i]!);
			const hoverLum = relLuminance(hoverValues[i]!);
			const pressedLum = relLuminance(pressedValues[i]!);
			// Darker means lower relative luminance, and each step should be a
			// perceptible jump, not a rounding-error's worth of difference.
			expect(hoverLum).toBeLessThan(restLum - 0.01);
			expect(pressedLum).toBeLessThan(hoverLum - 0.01);
		}
	});

	it('the [data-theme="light"] block and the system-light @media block agree on hover/pressed', () => {
		const hoverValues = tokenValues('--accent-hover');
		const pressedValues = tokenValues('--accent-pressed');
		expect(hoverValues[1]).toBe(hoverValues[2]);
		expect(pressedValues[1]).toBe(pressedValues[2]);
	});

	it('dark theme hover/pressed are untouched', () => {
		const hoverValues = tokenValues('--accent-hover');
		const pressedValues = tokenValues('--accent-pressed');
		expect(hoverValues[0]).toBe('#eeb878');
		expect(pressedValues[0]).toBe('#d79c5b');
	});
});
