import { describe, expect, it } from 'vitest';
import { isValidAddressFormat } from './address.js';

describe('isValidAddressFormat (client-safe format gate, hearth-5vw)', () => {
	it('accepts a well-formed mainnet bech32 address', () => {
		expect(isValidAddressFormat('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'mainnet')).toBe(true);
	});

	it('rejects an empty or whitespace-only address', () => {
		expect(isValidAddressFormat('', 'mainnet')).toBe(false);
		expect(isValidAddressFormat('   ', 'mainnet')).toBe(false);
	});

	it('rejects an address containing internal whitespace', () => {
		expect(isValidAddressFormat('bc1q cr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'mainnet')).toBe(false);
	});

	it('rejects garbage input', () => {
		expect(isValidAddressFormat('not-an-address', 'mainnet')).toBe(false);
	});

	it('rejects a testnet address on mainnet (network-bound)', () => {
		expect(isValidAddressFormat('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet')).toBe(false);
		expect(isValidAddressFormat('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet')).toBe(true);
	});
});
