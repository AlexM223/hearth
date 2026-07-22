/**
 * Address -> output script, ECC-free (ported from C:\dev\raffle\core\src\coinbase.ts
 * and cairn's C:\dev\cairn\src\lib\server\mining\address.ts -- the
 * addressToOutputScript / validateAddressEncodable / network-map slice only).
 *
 * bitcoinjs's toOutputScript needs an ECC lib initialized for taproot; but a
 * witness-vN output script is just OP_N <program> -- no curve math -- so
 * segwit addresses are built directly from the (checksum-validated)
 * bech32/bech32m decode. This keeps the mining engine free of any secp256k1
 * initialization (DECISIONS.md §2's no-native-ECC-deps posture).
 */
import * as bitcoin from 'bitcoinjs-lib';
import type { ChainNetwork } from '../wallet/index.js';

export type Network = bitcoin.networks.Network;

/**
 * ChainNetwork -> bitcoinjs params. Hearth's wallet module infers a network
 * PER WALLET from xpub version bytes (no single global "app network"
 * setting) -- the mining engine instead derives ONE network for the whole
 * job-construction/coinbase pipeline from Bitcoin Core's own
 * `getblockchaininfo().chain` at start time (mining/index.ts's start gate),
 * mapped through this same table. See mining/index.ts's `networkForCoreChain`
 * for that mapping; this table only covers hearth's three supported
 * `ChainNetwork` values.
 */
export const NETWORKS: Record<ChainNetwork, Network> = {
	mainnet: bitcoin.networks.bitcoin,
	testnet: bitcoin.networks.testnet,
	regtest: bitcoin.networks.regtest
};

export function networkFor(name: ChainNetwork): Network {
	return NETWORKS[name];
}

/**
 * Address -> output script, ECC-free. Segwit (v0 p2wpkh/p2wsh, v1+ taproot
 * and future witness versions) is compiled directly from the bech32/bech32m
 * decode; base58 (p2pkh / p2sh) falls through to bitcoinjs's
 * toOutputScript, which needs no ECC for those. Throws on an address
 * unencodable on this network.
 */
export function addressToOutputScript(address: string, network: Network): Buffer {
	try {
		const dec = bitcoin.address.fromBech32(address);
		if (dec.prefix !== network.bech32) {
			throw new Error(`wrong bech32 prefix for network: ${dec.prefix}`);
		}
		if (dec.version === 0 && (dec.data.length === 20 || dec.data.length === 32)) {
			return bitcoin.script.compile([bitcoin.opcodes.OP_0!, dec.data]);
		}
		if (dec.version >= 1 && dec.version <= 16 && dec.data.length >= 2 && dec.data.length <= 40) {
			// BIP341 restricts v1 programs to 32 bytes.
			if (dec.version === 1 && dec.data.length !== 32) {
				throw new Error('invalid v1 witness program length');
			}
			return bitcoin.script.compile([bitcoin.opcodes.OP_1! + dec.version - 1, dec.data]);
		}
		throw new Error('unsupported witness program');
	} catch (bech32Err) {
		try {
			// base58 (p2pkh / p2sh) -- handled fine without ECC.
			return bitcoin.address.toOutputScript(address, network);
		} catch {
			throw bech32Err instanceof Error ? bech32Err : new Error(String(bech32Err));
		}
	}
}

/**
 * Authorize-time gate: an address that cannot be encoded into an output
 * script on this network must never be handed a job (its coinbase would be
 * unpayable). Call before accepting a miner's payout address.
 */
export function validateAddressEncodable(address: string, network: Network): boolean {
	try {
		return addressToOutputScript(address, network).length > 0;
	} catch {
		return false;
	}
}
