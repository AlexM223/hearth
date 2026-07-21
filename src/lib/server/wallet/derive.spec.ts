/**
 * T1 acceptance (WALLET-ENGINE §7): single-sig derivation matches canonical
 * BIP-84/49/44 vectors on mainnet, works on testnet/regtest, is ECC-free
 * (address encoding cross-checks against @scure/btc-signer's independent
 * payment builders), and the hostile-xpub suite rejects private keys FIRST
 * without echoing the secret.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { deriveAddresses } from './index.js';
import { parseXpub, PrivateKeyRejectedError, InvalidKeyError } from './derive.js';
import type { ScriptType, ChainNetwork, Wallet } from './types.js';

function wallet(scriptType: ScriptType, xpub: string, network: ChainNetwork = 'mainnet'): Wallet {
	return {
		id: 1,
		userId: 1,
		name: 'w',
		kind: 'single',
		scriptType,
		network,
		threshold: 1,
		descriptor: null,
		receiveCursor: 0,
		changeCursor: 0,
		source: 'imported',
		keys: [{ position: 0, xpub, fingerprint: '00000000', path: "m/84'/0'/0'" }],
		createdAt: '2026-07-21T00:00:00.000Z'
	};
}

// Canonical BIP-84 account-0 zpub (from BIP-84 itself, mnemonic "abandon x11 about").
const BIP84_ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('T1: single-sig derivation (canonical vectors)', () => {
	it('derives BIP-84 (p2wpkh) receive addresses matching the BIP-84 vectors', () => {
		const w = wallet('p2wpkh', BIP84_ZPUB);
		const recv = deriveAddresses(w, 0, 0, 2);
		expect(recv[0].address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
		expect(recv[1].address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
	});

	it('derives BIP-84 change (chain 1) matching the BIP-84 vector', () => {
		const w = wallet('p2wpkh', BIP84_ZPUB);
		const change = deriveAddresses(w, 1, 0, 1);
		expect(change[0].address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
	});

	it('normalizes zpub SLIP-132 version bytes and infers p2wpkh', () => {
		const parsed = parseXpub(BIP84_ZPUB);
		expect(parsed.inferredScriptType).toBe('p2wpkh');
		expect(parsed.network).toBe('mainnet');
		expect(parsed.normalizedXpub.startsWith('xpub')).toBe(true);
	});

	it('scripthash + scriptPubKey are populated and consistent for each derived address', () => {
		const w = wallet('p2wpkh', BIP84_ZPUB);
		const [a] = deriveAddresses(w, 0, 0, 1);
		expect(a.scriptPubKey).toMatch(/^0014[0-9a-f]{40}$/);
		expect(a.scripthash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('T1: ECC-free encoding cross-checks @scure/btc-signer payment builders', () => {
	// Build an account xpub programmatically for each script type from a seed,
	// then assert our manual encoder == scure's independent implementation.
	const root = HDKey.fromMasterSeed(hex.decode('00'.repeat(32).replace(/00/g, '1a')));

	function xpubAt(path: string): { xpub: string; account: HDKey } {
		const account = root.derive(path);
		return { xpub: account.publicExtendedKey, account };
	}

	function scureAddr(scriptType: ScriptType, pub: Uint8Array, net: typeof btc.NETWORK): string {
		if (scriptType === 'p2wpkh') return btc.p2wpkh(pub, net).address!;
		if (scriptType === 'p2pkh') return btc.p2pkh(pub, net).address!;
		return btc.p2sh(btc.p2wpkh(pub, net), net).address!;
	}

	for (const [scriptType, net] of [
		['p2wpkh', 'mainnet'],
		['p2sh-p2wpkh', 'mainnet'],
		['p2pkh', 'mainnet'],
		['p2wpkh', 'testnet'],
		['p2wpkh', 'regtest']
	] as [ScriptType, ChainNetwork][]) {
		it(`${scriptType} on ${net} matches scure for chain0/index0..2`, () => {
			const { xpub, account } = xpubAt("m/84'/0'/0'");
			const w = wallet(scriptType, xpub, net);
			const addrs = deriveAddresses(w, 0, 0, 3);
			const scureNet =
				net === 'mainnet'
					? btc.NETWORK
					: net === 'testnet'
						? btc.TEST_NETWORK
						: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
			for (let i = 0; i < 3; i++) {
				const pub = account.deriveChild(0).deriveChild(i).publicKey!;
				expect(addrs[i].address).toBe(scureAddr(scriptType, pub, scureNet));
			}
		});
	}
});

describe('T1: hostile-xpub suite (WALLET-ENGINE §6.1)', () => {
	// A private extended key (xprv) for the abandon-x11 mnemonic.
	const XPRV =
		'xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu';

	it('rejects a private extended key with PrivateKeyRejectedError, never echoing the secret', () => {
		let thrown: unknown;
		try {
			parseXpub(XPRV);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(PrivateKeyRejectedError);
		expect((thrown as Error).message).not.toContain(XPRV);
		expect((thrown as Error).message.length).toBeGreaterThan(0);
	});

	it('rejects empty / whitespace input', () => {
		expect(() => parseXpub('   ')).toThrow(InvalidKeyError);
	});

	it('rejects a garbage key-field / bad checksum', () => {
		expect(() => parseXpub('xpub' + 'z'.repeat(107))).toThrow();
	});

	it('rejects a wrong-length base58 string', () => {
		expect(() => parseXpub('xpub6CUGRUo')).toThrow(InvalidKeyError);
	});

	it('rejects a truncated real zpub', () => {
		expect(() => parseXpub(BIP84_ZPUB.slice(0, 40))).toThrow();
	});
});
