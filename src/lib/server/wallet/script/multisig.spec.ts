/**
 * T2 acceptance (WALLET-ENGINE §7, §6.1): multisig ScriptEngine. sortedmulti /
 * BIP-67 (key order never changes an address), N bip32Derivations, exact vsize,
 * signingProgress (minimum per-input count), quorum-gated finalize, and the
 * combine guards (different-tx / foreign-sig / wrong-sighash).
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex, base64 } from '@scure/base';
import { selectEngine } from '../index.js';
import { MultisigEngine } from './multisig.js';
import {
	DifferentTransactionError,
	ForeignSignatureError,
	NotFullySignedError,
	WrongSighashError
} from '../errors.js';
import type { ChainNetwork, MultisigScriptType, Wallet } from '../types.js';

const ORIGIN = "m/48'/1'/0'/2'";

function roots(seedBytes: number[]): HDKey[] {
	return seedBytes.map((b) => HDKey.fromMasterSeed(new Uint8Array(32).fill(b)));
}

function makeWallet(
	rootKeys: HDKey[],
	threshold: number,
	scriptType: MultisigScriptType = 'p2wsh',
	network: ChainNetwork = 'testnet',
	order?: number[]
): Wallet {
	const idxOrder = order ?? rootKeys.map((_, i) => i);
	const keys = idxOrder.map((i, position) => {
		const account = rootKeys[i].derive(ORIGIN);
		return {
			position,
			xpub: account.publicExtendedKey,
			fingerprint: hex.encode(rootKeys[i].fingerprint ? u32ToBytes(rootKeys[i].fingerprint) : new Uint8Array(4)),
			path: ORIGIN
		};
	});
	return {
		id: 1,
		userId: 1,
		name: 'msig',
		kind: 'multisig',
		scriptType,
		network,
		threshold,
		descriptor: null,
		receiveCursor: 0,
		changeCursor: 0,
		source: 'imported',
		keys,
		createdAt: '2026-07-21T00:00:00.000Z'
	};
}

function u32ToBytes(n: number): Uint8Array {
	return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** Build an unsigned spending PSBT for a wallet's chain0/index0 coin. */
function buildBase(wallet: Wallet, amount = 90000n, changeAmount?: bigint): string {
	const engine = selectEngine(wallet);
	const utxo = {
		txid: '22'.repeat(32),
		vout: 0,
		valueSats: 100000,
		height: 100,
		address: engine.scriptFor(0, 0).address,
		chain: 0 as const,
		index: 0
	};
	const meta = engine.inputMeta(utxo);
	const tx = new btc.Transaction({ version: 2 });
	tx.addInput({ txid: hex.decode(utxo.txid), index: utxo.vout, ...meta });
	tx.addOutputAddress(engine.scriptFor(0, 1).address, amount, scureNet(wallet.network));
	if (changeAmount) tx.addOutputAddress(engine.scriptFor(1, 0).address, changeAmount, scureNet(wallet.network));
	return base64.encode(tx.toPSBT());
}

function scureNet(net: ChainNetwork) {
	if (net === 'mainnet') return btc.NETWORK;
	if (net === 'testnet') return btc.TEST_NETWORK;
	return { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
}

/** Sign a base PSBT with one cosigner's child private key. */
function signWith(baseB64: string, root: HDKey): string {
	const tx = btc.Transaction.fromPSBT(base64.decode(baseB64));
	const priv = root.derive(ORIGIN).deriveChild(0).deriveChild(0).privateKey!;
	tx.signIdx(priv, 0);
	return base64.encode(tx.toPSBT());
}

describe('T2: multisig sortedmulti / BIP-67', () => {
	const rk = roots([1, 2, 3]);

	it('key order in the wallet never changes a derived address (BIP-67)', () => {
		const w1 = makeWallet(rk, 2, 'p2wsh', 'testnet', [0, 1, 2]);
		const w2 = makeWallet(rk, 2, 'p2wsh', 'testnet', [2, 0, 1]);
		const e1 = selectEngine(w1);
		const e2 = selectEngine(w2);
		expect(e1.scriptFor(0, 0).address).toBe(e2.scriptFor(0, 0).address);
		expect(e1.scriptFor(1, 5).address).toBe(e2.scriptFor(1, 5).address);
	});

	it('matches scure p2wsh(p2ms(sorted)) for a 2-of-3 vector', () => {
		const w = makeWallet(rk, 2, 'p2wsh', 'testnet');
		const engine = selectEngine(w);
		const pubs = rk.map((r) => r.derive(ORIGIN).deriveChild(0).deriveChild(0).publicKey!);
		const sorted = [...pubs].sort((a, b) => {
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
			return 0;
		});
		const expected = btc.p2wsh(btc.p2ms(2, sorted), btc.TEST_NETWORK).address;
		expect(engine.scriptFor(0, 0).address).toBe(expected);
	});

	it('produces p2wsh, p2sh-p2wsh, and bare p2sh addresses of the right prefix', () => {
		expect(selectEngine(makeWallet(rk, 2, 'p2wsh')).scriptFor(0, 0).address.startsWith('tb1')).toBe(true);
		expect(/^2/.test(selectEngine(makeWallet(rk, 2, 'p2sh-p2wsh')).scriptFor(0, 0).address)).toBe(true);
		expect(/^2/.test(selectEngine(makeWallet(rk, 2, 'p2sh')).scriptFor(0, 0).address)).toBe(true);
	});

	it('estimates ~105 vB per input for 2-of-3 p2wsh', () => {
		const vsize = (selectEngine(makeWallet(rk, 2, 'p2wsh')) as MultisigEngine).perInputVsize();
		expect(vsize).toBeGreaterThan(95);
		expect(vsize).toBeLessThan(115);
	});

	it('stamps N bip32Derivations on every input', () => {
		const engine = selectEngine(makeWallet(rk, 2, 'p2wsh'));
		const meta = engine.inputMeta({
			txid: '00'.repeat(32),
			vout: 0,
			valueSats: 100000,
			height: 1,
			address: 'x',
			chain: 0,
			index: 0
		});
		expect(meta.bip32Derivation.length).toBe(3);
		expect(meta.witnessScript).toBeInstanceOf(Uint8Array);
	});
});

describe('T2: multisig signing progress + finalize (quorum-gated)', () => {
	const rk = roots([1, 2, 3]);
	const w = makeWallet(rk, 2, 'p2wsh');
	const engine = selectEngine(w) as MultisigEngine;

	it('reports required=2, collected=1, incomplete after one signer', () => {
		const base = buildBase(w);
		const oneSig = signWith(base, rk[0]);
		const p = engine.signingProgress(oneSig);
		expect(p.required).toBe(2);
		expect(p.collected).toBe(1);
		expect(p.complete).toBe(false);
	});

	it('reaches collected=2, complete after combining a second signer', () => {
		const base = buildBase(w);
		const a = signWith(base, rk[0]);
		const b = signWith(base, rk[1]);
		const combined = engine.combine(a, b);
		const p = engine.signingProgress(combined);
		expect(p.collected).toBe(2);
		expect(p.complete).toBe(true);
	});

	it('finalize refuses below quorum (NotFullySignedError) but succeeds at quorum', () => {
		const base = buildBase(w);
		const a = signWith(base, rk[0]);
		expect(() => engine.finalize(a)).toThrow(NotFullySignedError);
		const combined = engine.combine(a, signWith(base, rk[1]));
		const final = engine.finalize(combined);
		expect(final.txid).toMatch(/^[0-9a-f]{64}$/);
		expect(final.rawHex.length).toBeGreaterThan(0);
	});

	it('combine is idempotent (re-merging a present signature is a no-op)', () => {
		const base = buildBase(w);
		const a = signWith(base, rk[0]);
		const once = engine.combine(base, a);
		const twice = engine.combine(once, a);
		expect(engine.signingProgress(twice).collected).toBe(1);
	});
});

describe('T2: combine guards (WALLET-ENGINE §5.2)', () => {
	const rk = roots([1, 2, 3]);
	const w = makeWallet(rk, 2, 'p2wsh');
	const engine = selectEngine(w) as MultisigEngine;

	it('rejects combine of PSBTs for DIFFERENT transactions', () => {
		const a = signWith(buildBase(w, 90000n), rk[0]);
		const b = signWith(buildBase(w, 91000n), rk[1]);
		expect(() => engine.combine(a, b)).toThrow(DifferentTransactionError);
	});

	it('rejects a FOREIGN signature (pubkey not a cosigner)', () => {
		const base = buildBase(w);
		const signed = signWith(base, rk[0]);
		const sig = (btc.Transaction.fromPSBT(base64.decode(signed)).getInput(0).partialSig as [Uint8Array, Uint8Array][])[0][1];
		const foreign = HDKey.fromMasterSeed(new Uint8Array(32).fill(99)).deriveChild(0).publicKey!;
		const crafted = btc.Transaction.fromPSBT(base64.decode(base));
		crafted.updateInput(0, { partialSig: [[foreign, sig]] });
		expect(() => engine.combine(base, base64.encode(crafted.toPSBT()))).toThrow(ForeignSignatureError);
	});

	it('rejects a NON-SIGHASH_ALL signature', () => {
		const base = buildBase(w);
		const signed = signWith(base, rk[0]);
		const [pub, sig] = (btc.Transaction.fromPSBT(base64.decode(signed)).getInput(0).partialSig as [Uint8Array, Uint8Array][])[0];
		const wrong = new Uint8Array(sig);
		wrong[wrong.length - 1] = 0x03; // SIGHASH_SINGLE
		const crafted = btc.Transaction.fromPSBT(base64.decode(base));
		crafted.updateInput(0, { partialSig: [[pub, wrong]] });
		expect(() => engine.combine(base, base64.encode(crafted.toPSBT()))).toThrow(WrongSighashError);
	});
});
