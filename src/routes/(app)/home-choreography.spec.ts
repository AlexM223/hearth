/**
 * T8 acceptance (COME-ABOARD.md §2.5, §8): the hero switches from the
 * "aboard" message to the caller's own balance based on role + wallet count.
 */
import { describe, expect, it } from 'vitest';
import { heroKindFor } from './home-choreography.js';

describe('T8: heroKindFor', () => {
	it('Owner always sees their own balance, even with zero wallets', () => {
		expect(heroKindFor('owner', 0)).toBe('balance');
		expect(heroKindFor('owner', 3)).toBe('balance');
	});

	it('a fresh Member (zero wallets) sees the aboard message', () => {
		expect(heroKindFor('member', 0)).toBe('aboard');
	});

	it('a Member with at least one wallet sees their own balance', () => {
		expect(heroKindFor('member', 1)).toBe('balance');
		expect(heroKindFor('member', 4)).toBe('balance');
	});

	it('a Guest always sees the aboard message (never holds a wallet)', () => {
		expect(heroKindFor('guest', 0)).toBe('aboard');
	});
});
