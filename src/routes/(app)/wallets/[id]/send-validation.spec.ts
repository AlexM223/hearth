/**
 * Regression test for hearth-5vw (UX sweep finding #3, High), client half:
 * "the button is never disabled -- no client-side required-field check
 * exists" -- clicking Review with empty To-address/Amount fields fired the
 * request straight to the server. This is a source-level assertion (no
 * component-test harness in this repo -- see mining/keyed-lists.spec.ts)
 * that the Review button is wired to a validity check covering both fields,
 * and that inline field-level hints exist (per the sweep's suggested fix:
 * "disable Review / inline 'enter a recipient' / 'enter an amount'
 * messages").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('wallet detail Send form gates on client-side validity (hearth-5vw)', () => {
	it('imports the shared address/amount validators (not a bespoke ad-hoc check)', () => {
		expect(source).toContain("from '$lib/shared/address.js'");
		expect(source).toContain("from '$lib/shared/amount.js'");
	});

	it('the Review button is disabled while the form is invalid', () => {
		expect(source).toMatch(/disabled=\{sendBusy \|\| !canReview\}/);
	});

	it('buildDraft() itself refuses to fire when !canReview (defense in depth, not just the disabled attribute)', () => {
		expect(source).toMatch(/if \(!canReview\) return;/);
	});

	it('shows an inline hint for an empty/invalid address and an empty/invalid amount', () => {
		expect(source).toContain('Enter a recipient address.');
		expect(source).toContain('Enter an amount.');
	});
});
