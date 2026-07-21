/**
 * Recipient (and change) address decode + validation (WALLET-ENGINE §6.1
 * hostile-address suite). Every failure -> InvalidRecipientError with a clean
 * message containing "valid bitcoin address" (no [object Object]/undefined/
 * stack). Also classifies the output kind for outputVsize / dust math (§2.6).
 *
 * Uses @scure/btc-signer's network-bound Address decoder (ECC-free), which
 * rejects wrong-network HRP/version, mixed-case bech32, bad checksums, empty/
 * garbage, Unicode lookalikes, and wrong-length witness programs.
 */
import * as btc from '@scure/btc-signer';
import type { ChainNetwork } from './types.js';
import { InvalidRecipientError } from './errors.js';

export type OutputKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

export interface DecodedAddress {
	scriptPubKey: Uint8Array;
	kind: OutputKind;
}

const REGTEST_NET = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export function scureNetwork(network: ChainNetwork): typeof btc.NETWORK {
	if (network === 'mainnet') return btc.NETWORK;
	if (network === 'testnet') return btc.TEST_NETWORK;
	return REGTEST_NET;
}

function mapKind(type: string): OutputKind {
	switch (type) {
		case 'pkh':
			return 'p2pkh';
		case 'sh':
			return 'p2sh';
		case 'wpkh':
			return 'p2wpkh';
		case 'wsh':
			return 'p2wsh';
		case 'tr':
			return 'p2tr';
		default:
			throw new InvalidRecipientError('that is not a spendable bitcoin address type');
	}
}

function clip(s: string): string {
	return s.length > 24 ? s.slice(0, 21) + '...' : s;
}

/** Decode + validate a recipient/change address for `network`. Throws
 *  InvalidRecipientError (message contains "valid bitcoin address") on any fault. */
export function decodeAddress(address: unknown, network: ChainNetwork): DecodedAddress {
	if (typeof address !== 'string') {
		throw new InvalidRecipientError('enter a valid bitcoin address');
	}
	const trimmed = address.trim();
	if (trimmed === '') throw new InvalidRecipientError('enter a valid bitcoin address');
	if (/\s/.test(trimmed)) throw new InvalidRecipientError('not a valid bitcoin address');
	let scriptPubKey: Uint8Array;
	let type: string;
	try {
		const outScript = btc.Address(scureNetwork(network)).decode(trimmed);
		scriptPubKey = btc.OutScript.encode(outScript as Parameters<typeof btc.OutScript.encode>[0]);
		type = (outScript as { type: string }).type;
	} catch (e) {
		if (e instanceof InvalidRecipientError) throw e;
		throw new InvalidRecipientError(
			`"${clip(trimmed)}" is not a valid bitcoin address for ${network}`
		);
	}
	return { scriptPubKey, kind: mapKind(type) };
}

/** True if the address is decodable for the network (no throw). */
export function isValidAddress(address: string, network: ChainNetwork): boolean {
	try {
		decodeAddress(address, network);
		return true;
	} catch {
		return false;
	}
}
