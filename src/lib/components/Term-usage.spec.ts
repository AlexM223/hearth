/**
 * Regression test for hearth-r6p (UX sweep finding #7, Medium): the three
 * concretely un-glossed jargon instances the sweep listed as "highest
 * traffic for a non-technical invitee" -- the import form's xpub/descriptor
 * hint, the Send form's "Fee rate (sat/vB)" label, and the tx detail page's
 * raw "nulldata" script-type string -- now use <Term> instead of bare text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(rel: string): string {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('<Term> is wired into the sweep\'s three listed jargon instances (hearth-r6p)', () => {
	it('the wallet import hint glosses xpub/ypub/zpub and descriptor', () => {
		const source = read('../../routes/(app)/wallets/+page.svelte');
		expect(source).toContain("import Term from '$lib/components/Term.svelte'");
		expect(source).toMatch(/<Term\s+label="xpub\/ypub\/zpub"/);
		expect(source).toMatch(/<Term\s+label="descriptor"/);
	});

	it('the Send form\'s fee rate label glosses sat/vB', () => {
		const source = read('../../routes/(app)/wallets/[id]/+page.svelte');
		expect(source).toContain("import Term from '$lib/components/Term.svelte'");
		expect(source).toMatch(/<Term\s+label="sat\/vB"/);
	});

	it('the tx detail page glosses a "nulldata" (OP_RETURN) output instead of showing the raw script-type string', () => {
		const source = read('../../routes/(app)/explorer/tx/[txid]/+page.svelte');
		expect(source).toContain("import Term from '$lib/components/Term.svelte'");
		expect(source).toMatch(/vout\.scriptType === 'nulldata'/);
		expect(source).toMatch(/<Term\s+label="nulldata"/);
	});
});
