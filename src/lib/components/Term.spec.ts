/**
 * Regression test for hearth-r6p (UX sweep finding #7, Medium): DECISIONS.md
 * §1 requires "Bitcoin jargon (xpub, PSBT, UTXO, sat/vB) is glossed one tap
 * down via a `<Term>` mechanism, never in a primary row" -- `grep -r "Term"
 * src/lib/components` found no such file before this fix. Source-level
 * assertion (no component-test harness in this repo -- see
 * mining/keyed-lists.spec.ts) that the component exists, uses a native
 * <details>/<summary> disclosure (accessible, keyboard-operable, "one tap
 * down" with zero JS state), and accepts a plain-language definition.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./Term.svelte', import.meta.url)), 'utf8');

describe('<Term> jargon-glossing component exists (hearth-r6p, DECISIONS.md §1)', () => {
	it('takes a label (the jargon as shown inline) and a plain-language definition', () => {
		expect(source).toMatch(/let \{ label, definition \}/);
	});

	it('is a native <details>/<summary> disclosure -- one tap down, no JS state', () => {
		expect(source).toMatch(/<details class="term">/);
		expect(source).toMatch(/<summary class="term-summary[^"]*">\{label\}<\/summary>/);
		expect(source).toContain('{definition}');
	});

	it('hides the default disclosure marker so it reads as glossed text, not an accordion', () => {
		expect(source).toContain('::marker');
		expect(source).toContain('::-webkit-details-marker');
	});
});
