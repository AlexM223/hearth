/**
 * Regression test for hearth-3bv (M1 leftover): the Home watchtower
 * empty-state copy pointed the user to "connect your node in Settings" even
 * when the node is already connected. The correct empty state invites the
 * user to import/create a wallet (the actual next step in the M2 world).
 * This is a source-level assertion (copy lives in a .svelte template).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const homePage = fileURLToPath(new URL('./+page.svelte', import.meta.url));

describe('Home watchtower empty state (hearth-3bv)', () => {
	const source = readFileSync(homePage, 'utf8');

	it('no longer tells a connected user to connect their node in Settings', () => {
		expect(source).not.toContain('connect your node in Settings');
	});

	it('invites the user to import or create a wallet instead', () => {
		expect(source).toContain('import or create a wallet');
	});
});
