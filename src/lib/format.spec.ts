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
import { approxAgeFromDepth, formatSats } from './format.js';

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

describe('approxAgeFromDepth (~10 min per block, always "~"-prefixed)', () => {
	it('returns "" for zero/negative depth (unconfirmed, at-tip, unknown tip)', () => {
		expect(approxAgeFromDepth(0)).toBe('');
		expect(approxAgeFromDepth(-3)).toBe('');
	});

	it('minutes under an hour', () => {
		expect(approxAgeFromDepth(1)).toBe('~10 min ago');
		expect(approxAgeFromDepth(5)).toBe('~50 min ago');
	});

	it('hours up to a day and a half', () => {
		expect(approxAgeFromDepth(6)).toBe('~1 h ago');
		expect(approxAgeFromDepth(144)).toBe('~24 h ago');
	});

	it('days under two months', () => {
		expect(approxAgeFromDepth(6 * 24 * 3)).toBe('~3 d ago');
	});

	it('months under two years', () => {
		expect(approxAgeFromDepth(6 * 24 * 90)).toBe('~3 mo ago');
	});

	it('years beyond that', () => {
		// ~3 years of blocks: 3 * 365 * 144
		expect(approxAgeFromDepth(3 * 365 * 144)).toBe('~3 y ago');
	});
});
