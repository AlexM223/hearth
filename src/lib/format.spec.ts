/**
 * Regression lock for hearth-lm1.15 ("zero balance renders blank"). Live
 * browser verification reported /wallets and the wallet hero showing "sats"
 * with no leading number when confirmedSats is 0. Re-review of the current
 * wallets list + wallet detail components (and a live render against the
 * real dev-DB wallet with confirmedSats:0) did not reproduce a blank render
 * -- `toLocaleString` already renders 0 as "0" -- but the two components each
 * had their OWN copy-pasted formatter, which is exactly the kind of
 * duplication that lets this class of bug reappear silently in one spot
 * while "fixed" in the other. This test pins the shared, single
 * implementation both components now import.
 */
import { describe, expect, it } from 'vitest';
import { formatSats } from './format.js';

describe('formatSats (hearth-lm1.15 regression)', () => {
	it('renders zero as "0", never as an empty string', () => {
		expect(formatSats(0)).toBe('0');
		expect(formatSats(0)).not.toBe('');
	});

	it('groups thousands for a typical balance', () => {
		expect(formatSats(150000)).toBe('150,000');
	});

	it('renders a negative amount (an outgoing delta) with its sign', () => {
		expect(formatSats(-5000)).toBe('-5,000');
	});
});
