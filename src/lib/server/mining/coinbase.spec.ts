/**
 * T2 acceptance (MINING-ENGINE.md §9.1, §3.2): coinbase value-conservation +
 * shape, BIP34 height push correctness, oversized poolTag trimmed to a
 * ≤100-byte scriptSig, and the one-value-output guard throwing on a
 * deliberately-split transaction.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { addressToOutputScript, networkFor } from './address.js';
import { assertSoloCoinbaseShape, buildScriptSigPrefix, buildSoloCoinbaseTx, MAX_SCRIPTSIG_SIZE } from './coinbase.js';

const net = networkFor('regtest');
const MINER = addressToOutputScript('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', net);
const EXTRANONCE_SIZE = 8;

describe('coinbase/buildScriptSigPrefix', () => {
	it('BIP34-encodes the height as the first scriptSig element', () => {
		const { scriptPrefix } = buildScriptSigPrefix(934200, 'Hearth', EXTRANONCE_SIZE);
		const chunks = bitcoin.script.decompile(scriptPrefix.subarray(0, scriptPrefix.length - 'Hearth'.length));
		// The height push is BIP34 minimal encoding — decode it back and check
		// it round-trips to 934200 (script.number.decode reverses script.number.encode).
		const heightPush = bitcoin.script.compile([bitcoin.script.number.encode(934200)]);
		expect(scriptPrefix.subarray(0, heightPush.length)).toEqual(heightPush);
		expect(chunks).not.toBeNull();
	});

	it('appends the pool tag verbatim when it fits', () => {
		const { scriptPrefix, scriptLen } = buildScriptSigPrefix(100, 'Hearth', EXTRANONCE_SIZE);
		expect(scriptPrefix.subarray(scriptPrefix.length - 'Hearth'.length).toString('ascii')).toBe('Hearth');
		expect(scriptLen).toBe(scriptPrefix.length + EXTRANONCE_SIZE);
	});

	it('trims an oversized pool tag so the FULL scriptSig (prefix + extranonce) stays ≤100 bytes', () => {
		const hugeTag = 'X'.repeat(200);
		const { scriptPrefix, scriptLen } = buildScriptSigPrefix(700000, hugeTag, EXTRANONCE_SIZE);
		expect(scriptLen).toBeLessThanOrEqual(MAX_SCRIPTSIG_SIZE);
		expect(scriptPrefix.length + EXTRANONCE_SIZE).toBeLessThanOrEqual(MAX_SCRIPTSIG_SIZE);
	});

	it('rejects an out-of-range height', () => {
		expect(() => buildScriptSigPrefix(-1, 'Hearth', EXTRANONCE_SIZE)).toThrow(/out of range/);
		expect(() => buildScriptSigPrefix(0x1_0000_0000, 'Hearth', EXTRANONCE_SIZE)).toThrow(/out of range/);
	});
});

describe('coinbase/buildSoloCoinbaseTx', () => {
	const scriptPrefix = buildScriptSigPrefix(800000, 'Hearth', EXTRANONCE_SIZE).scriptPrefix;
	const extranoncePlaceholder = Buffer.alloc(EXTRANONCE_SIZE, 0);

	it('conservation holds WITH a witness commitment (2 outputs: payout + zero-value commitment)', () => {
		const commitment = Buffer.alloc(34, 0xab).toString('hex');
		const tx = buildSoloCoinbaseTx({
			scriptPrefix,
			extranoncePlaceholder,
			payoutScript: MINER,
			coinbaseValueSats: 5_000_000_000n,
			witnessCommitmentHex: commitment
		});
		expect(tx.outs).toHaveLength(2);
		expect(BigInt(tx.outs[0]!.value)).toBe(5_000_000_000n);
		expect(tx.outs[1]!.value).toBe(0);
		const total = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n);
		expect(total).toBe(5_000_000_000n);
	});

	it('conservation holds WITHOUT a witness commitment (1 output)', () => {
		const tx = buildSoloCoinbaseTx({
			scriptPrefix,
			extranoncePlaceholder,
			payoutScript: MINER,
			coinbaseValueSats: 1_234_567n,
			witnessCommitmentHex: null
		});
		expect(tx.outs).toHaveLength(1);
		expect(BigInt(tx.outs[0]!.value)).toBe(1_234_567n);
	});

	it('the extranonce placeholder bytes are zero pre-split (the offset defense check job.ts relies on)', () => {
		const tx = buildSoloCoinbaseTx({
			scriptPrefix,
			extranoncePlaceholder,
			payoutScript: MINER,
			coinbaseValueSats: 100n,
			witnessCommitmentHex: null
		});
		const serialized = tx.toBuffer();
		const en1Offset = 4 + 1 + 36 + 1 /* varint(scriptLen).length for a small script */ + scriptPrefix.length;
		expect(serialized.subarray(en1Offset, en1Offset + EXTRANONCE_SIZE)).toEqual(Buffer.alloc(EXTRANONCE_SIZE, 0));
	});
});

describe('coinbase/assertSoloCoinbaseShape (the one-value-output guard)', () => {
	it('passes for a single-value-output coinbase', () => {
		const tx = new bitcoin.Transaction();
		tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
		tx.addOutput(Buffer.from(MINER), 5000);
		expect(() => assertSoloCoinbaseShape(tx, 5000n)).not.toThrow();
	});

	it('throws /splitting is forbidden/ for a coinbase with a SECOND value-bearing output (hand-crafted split attempt)', () => {
		const tx = new bitcoin.Transaction();
		tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
		tx.addOutput(Buffer.from(MINER), 2500);
		tx.addOutput(Buffer.from(MINER), 2500); // a second value output — a split
		expect(() => assertSoloCoinbaseShape(tx, 5000n)).toThrow(/splitting is forbidden/);
	});

	it('throws /value conservation violated/ when outputs do not sum to coinbaseValueSats', () => {
		const tx = new bitcoin.Transaction();
		tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
		tx.addOutput(Buffer.from(MINER), 4000);
		expect(() => assertSoloCoinbaseShape(tx, 5000n)).toThrow(/value conservation violated/);
	});

	it('a zero-value witness-commitment output never counts as a second value output', () => {
		const tx = new bitcoin.Transaction();
		tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
		tx.addOutput(Buffer.from(MINER), 5000);
		tx.addOutput(Buffer.alloc(34, 0), 0);
		expect(() => assertSoloCoinbaseShape(tx, 5000n)).not.toThrow();
	});
});
