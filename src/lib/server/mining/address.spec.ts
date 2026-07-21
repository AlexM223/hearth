/**
 * T1 acceptance (MINING-ENGINE.md §9.1, §3.2): ECC-free address -> output
 * script for every script kind the payout wallet can be, on every network,
 * plus the authorize-time encodability gate.
 */
import { describe, expect, it } from 'vitest';
import { addressToOutputScript, validateAddressEncodable, networkFor, NETWORKS } from './address.js';

describe('mining/address: networkFor', () => {
	it('maps all three ChainNetwork values', () => {
		expect(networkFor('mainnet')).toBe(NETWORKS.mainnet);
		expect(networkFor('testnet')).toBe(NETWORKS.testnet);
		expect(networkFor('regtest')).toBe(NETWORKS.regtest);
	});
});

describe('mining/address: addressToOutputScript', () => {
	it('encodes a mainnet p2wpkh (bech32 v0, 20-byte program) as OP_0 <20 bytes>', () => {
		const script = addressToOutputScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', networkFor('mainnet'));
		expect(script.length).toBe(22); // OP_0 (1) + push (1) + 20
		expect(script[0]).toBe(0x00);
		expect(script[1]).toBe(20);
	});

	it('encodes a mainnet p2wsh (bech32 v0, 32-byte program) as OP_0 <32 bytes>', () => {
		const script = addressToOutputScript(
			'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
			networkFor('mainnet')
		);
		expect(script.length).toBe(34);
		expect(script[0]).toBe(0x00);
		expect(script[1]).toBe(32);
	});

	it('encodes a mainnet taproot (bech32m v1) as OP_1 <32 bytes>', () => {
		const script = addressToOutputScript(
			'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
			networkFor('mainnet')
		);
		expect(script.length).toBe(34);
		expect(script[0]).toBe(0x51); // OP_1
		expect(script[1]).toBe(32);
	});

	it('encodes a mainnet p2pkh (base58) address', () => {
		const script = addressToOutputScript('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', networkFor('mainnet'));
		expect(script[0]).toBe(0x76); // OP_DUP
	});

	it('rejects a testnet address on mainnet (wrong bech32 prefix)', () => {
		expect(() =>
			addressToOutputScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', networkFor('mainnet'))
		).toThrow();
	});

	it('rejects garbage input cleanly (no ECC lib crash, just a thrown Error)', () => {
		expect(() => addressToOutputScript('not-an-address', networkFor('mainnet'))).toThrow();
	});

	it('regtest bech32 (bcrt1) round-trips through the regtest network params', () => {
		// A regtest p2wpkh derived address shares mainnet's program length/version
		// rules; only the hrp differs ('bcrt').
		const script = addressToOutputScript('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', networkFor('regtest'));
		expect(script[0]).toBe(0x00);
		expect(script[1]).toBe(20);
	});
});

describe('mining/address: validateAddressEncodable', () => {
	it('true for a valid same-network address', () => {
		expect(validateAddressEncodable('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', networkFor('mainnet'))).toBe(
			true
		);
	});

	it('false for a cross-network address', () => {
		expect(
			validateAddressEncodable('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', networkFor('mainnet'))
		).toBe(false);
	});

	it('false for garbage, never throws', () => {
		expect(() => validateAddressEncodable('garbage', networkFor('mainnet'))).not.toThrow();
		expect(validateAddressEncodable('garbage', networkFor('mainnet'))).toBe(false);
	});
});
