/**
 * T5 acceptance (WALLET-ENGINE §7, §2.6): coin-selection math. Core-exact dust
 * (546/540/294/330), fee rounds up, change vs changeless, BIP-69 ordering,
 * send-max, coin-control, fee-rate guards, insufficient funds.
 */
import { describe, expect, it } from 'vitest';
import {
	selectCoins,
	dustThreshold,
	outputVsize,
	bip69SortInputs,
	bip69SortOutputs
} from './select.js';
import { selectEngine } from './script/engine.js';
import { InsufficientFundsError, InvalidFeeRateError, InvalidRecipientError } from './errors.js';
import type { SpendableUtxo, Wallet } from './types.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function wallet(): Wallet {
	return {
		id: 1,
		userId: 1,
		name: 'w',
		kind: 'single',
		scriptType: 'p2wpkh',
		network: 'mainnet',
		threshold: 1,
		descriptor: null,
		receiveCursor: 0,
		changeCursor: 0,
		source: 'imported',
		keys: [{ position: 0, xpub: ZPUB, fingerprint: '00000000', path: "m/84'/0'/0'" }],
		createdAt: '2026-07-21T00:00:00.000Z'
	};
}
const engine = selectEngine(wallet());

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // p2wpkh

function utxo(txid: string, vout: number, value: number, height = 800000): SpendableUtxo {
	return { txid, vout, valueSats: value, height, address: 'a', chain: 0, index: vout };
}

function baseReq(utxos: SpendableUtxo[], amount: number | 'max', extra = {}) {
	return {
		engine,
		scriptType: 'p2wpkh' as const,
		network: 'mainnet' as const,
		utxos,
		recipients: [{ address: RECIP, amountSats: amount }],
		feeRate: 10,
		minFeeRate: 1,
		tipHeight: 800100,
		...extra
	};
}

describe('T5: dust + vsize constants (Core-exact)', () => {
	it('matches Core dust thresholds', () => {
		expect(dustThreshold('p2pkh')).toBe(546);
		expect(dustThreshold('p2sh')).toBe(540);
		expect(dustThreshold('p2wpkh')).toBe(294);
		expect(dustThreshold('p2wsh')).toBe(330);
		expect(dustThreshold('p2tr')).toBe(330);
	});
	it('matches output vsizes', () => {
		expect(outputVsize('p2wpkh')).toBe(31);
		expect(outputVsize('p2pkh')).toBe(34);
		expect(outputVsize('p2sh')).toBe(32);
		expect(outputVsize('p2wsh')).toBe(43);
	});
});

describe('T5: selection with change', () => {
	it('funds a send and keeps a non-dust change output; fee rounds up', () => {
		const sel = selectCoins(baseReq([utxo('a'.repeat(64), 0, 1_000_000)], 100_000));
		expect(sel.changeAmountSats).not.toBeNull();
		expect(sel.feeSats).toBeGreaterThan(0);
		// value conservation: inputs = recipients + change + fee
		expect(sel.totalInputSats).toBe(100_000 + (sel.changeAmountSats ?? 0) + sel.feeSats);
		// fee == ceil(vsize*rate)
		expect(sel.feeSats).toBe(Math.ceil(sel.vsize * 10));
	});

	it('goes changeless when the remainder would be dust (absorbed into fee)', () => {
		// Craft an input just barely over amount+fee so change would be sub-dust.
		const amount = 100_000;
		// one p2wpkh input(68) + 1 recipient(31) + overhead(11) = 110 vsize changeless
		const feeNoChange = Math.ceil(110 * 10);
		const value = amount + feeNoChange + 50; // 50 sats leftover < 294 dust
		const sel = selectCoins(baseReq([utxo('b'.repeat(64), 0, value)], amount));
		expect(sel.changeAmountSats).toBeNull();
		expect(sel.feeSats).toBe(value - amount);
	});
});

describe('T5: send-max + coin control', () => {
	it('send-max sweeps everything, amount = total - fee', () => {
		const utxos = [utxo('c'.repeat(64), 0, 500_000), utxo('d'.repeat(64), 1, 300_000)];
		const sel = selectCoins(baseReq(utxos, 'max'));
		expect(sel.changeAmountSats).toBeNull();
		expect(sel.inputs.length).toBe(2);
		expect(sel.recipients[0].amountSats).toBe(800_000 - sel.feeSats);
	});

	it('coin control uses exactly the allowlist', () => {
		const utxos = [utxo('e'.repeat(64), 0, 500_000), utxo('f'.repeat(64), 1, 500_000)];
		const sel = selectCoins(baseReq(utxos, 100_000, { onlyUtxos: [{ txid: 'f'.repeat(64), vout: 1 }] }));
		expect(sel.inputs.length).toBe(1);
		expect(sel.inputs[0].txid).toBe('f'.repeat(64));
	});
});

describe('T5: guards', () => {
	it('rejects a non-positive / too-high / below-relay fee rate', () => {
		expect(() => selectCoins(baseReq([utxo('a'.repeat(64), 0, 1e6)], 1000, { feeRate: 0 }))).toThrow(InvalidFeeRateError);
		expect(() => selectCoins(baseReq([utxo('a'.repeat(64), 0, 1e6)], 1000, { feeRate: 5000 }))).toThrow(InvalidFeeRateError);
		expect(() => selectCoins(baseReq([utxo('a'.repeat(64), 0, 1e6)], 1000, { feeRate: 0.5, minFeeRate: 1 }))).toThrow(InvalidFeeRateError);
	});

	it('rejects an invalid recipient address', () => {
		expect(() => selectCoins(baseReq([utxo('a'.repeat(64), 0, 1e6)], 100_000, { recipients: [{ address: 'notanaddress', amountSats: 100_000 }] }))).toThrow(InvalidRecipientError);
	});

	it('throws InsufficientFundsError when funds cannot cover amount + fee', () => {
		expect(() => selectCoins(baseReq([utxo('a'.repeat(64), 0, 50_000)], 100_000))).toThrow(InsufficientFundsError);
	});

	it('excludes reserved coins from auto-selection', () => {
		const utxos = [utxo('a'.repeat(64), 0, 1_000_000)];
		const reserved = new Set([`${'a'.repeat(64)}:0`]);
		expect(() => selectCoins(baseReq(utxos, 100_000, { reservedOutpoints: reserved }))).toThrow(InsufficientFundsError);
	});

	it('excludes immature coinbase coins (fail-closed)', () => {
		const cb: SpendableUtxo = { ...utxo('a'.repeat(64), 0, 1_000_000, 800050), coinbase: true };
		// tip 800100 -> 51 confs < 100 maturity
		expect(() => selectCoins(baseReq([cb], 100_000))).toThrow(InsufficientFundsError);
	});
});

describe('T5: BIP-69 ordering', () => {
	it('sorts inputs by txid asc then vout asc', () => {
		const ins = bip69SortInputs([utxo('ff'.repeat(32), 2, 1), utxo('00'.repeat(32), 5, 1), utxo('00'.repeat(32), 1, 1)]);
		expect(ins.map((i) => `${i.txid.slice(0, 2)}:${i.vout}`)).toEqual(['00:1', '00:5', 'ff:2']);
	});
	it('sorts outputs by value asc then script hex', () => {
		const outs = bip69SortOutputs([
			{ address: null, scriptPubKey: new Uint8Array([2]), amountSats: 100, isChange: true, kind: 'p2wpkh' },
			{ address: null, scriptPubKey: new Uint8Array([1]), amountSats: 100, isChange: false, kind: 'p2wpkh' },
			{ address: null, scriptPubKey: new Uint8Array([9]), amountSats: 50, isChange: false, kind: 'p2wpkh' }
		]);
		expect(outs.map((o) => o.amountSats)).toEqual([50, 100, 100]);
		expect(outs[1].scriptPubKey![0]).toBe(1);
	});
});
