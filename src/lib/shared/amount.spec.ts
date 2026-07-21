import { describe, expect, it } from 'vitest';
import { isValidSendAmount, MIN_SEND_SATS, MAX_SEND_SATS } from './amount.js';

describe('isValidSendAmount (client-safe amount gate, hearth-5vw)', () => {
	it('rejects an empty string (the sweep\'s Number(\'\') === NaN repro)', () => {
		expect(isValidSendAmount('')).toBe(false);
		expect(Number.isNaN(Number(''))).toBe(false); // Number('') is 0, not NaN -- confirms 0 is separately rejected below
	});

	it('rejects zero and negative amounts', () => {
		expect(isValidSendAmount('0')).toBe(false);
		expect(isValidSendAmount('-1')).toBe(false);
	});

	it('rejects non-numeric and fractional input', () => {
		expect(isValidSendAmount('abc')).toBe(false);
		expect(isValidSendAmount('100.5')).toBe(false);
	});

	it('rejects below the conservative dust floor', () => {
		expect(isValidSendAmount(String(MIN_SEND_SATS - 1))).toBe(false);
	});

	it('accepts a sane whole-sat amount at and above the floor', () => {
		expect(isValidSendAmount(String(MIN_SEND_SATS))).toBe(true);
		expect(isValidSendAmount('100000')).toBe(true);
	});

	it('rejects above the 21M BTC sanity ceiling', () => {
		expect(isValidSendAmount(String(MAX_SEND_SATS + 1))).toBe(false);
		expect(isValidSendAmount(String(MAX_SEND_SATS))).toBe(true);
	});
});
