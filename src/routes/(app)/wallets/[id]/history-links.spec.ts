/**
 * Regression test for hearth-oiz (UX sweep finding #4, Medium): each wallet
 * History row was an inert `<li>` -- a truncated txid as plain text, no
 * `<a>`, no click handler, no copy affordance -- even though the exact same
 * data links correctly from the Explorer (`/explorer/block/[hash]` -> tx
 * rows). Source-level assertion (no component-test harness -- see
 * mining/keyed-lists.spec.ts) that each history row now links to the FULL
 * txid (the data is already present; only the display label is truncated).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('wallet History rows link to the explorer tx page (hearth-oiz)', () => {
	it('each history row is an <a> to /explorer/tx/<full txid>, not a bare <li>', () => {
		expect(source).toMatch(/<a class="tx" href=\{`\/explorer\/tx\/\$\{tx\.txid\}`\}>/);
	});

	it('links to the FULL txid, not the truncated display label', () => {
		// The truncated label (tx.txid.slice(0, N)) must still exist for display,
		// but the href must reference tx.txid directly, unsliced.
		expect(source).toMatch(/tx\.txid\.slice\(0, 12\)/);
		expect(source).toMatch(/href=\{`\/explorer\/tx\/\$\{tx\.txid\}`\}/);
	});
});
