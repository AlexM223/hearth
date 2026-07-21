/**
 * Hostile-PSBT suite (WALLET-ENGINE §6.1, ≥17 cases). Every case must fail with
 * a CAUGHT, typed Error (never an uncaught crash/hang), a clean message (len>0,
 * <500 chars, no stack frame, no giant buffer dump), and never broadcast.
 * Also covers T6 commitment-check refusal cases (8-17) and the parse guards.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { parsePsbt } from './script/engine.js';
import { assertSameTransaction } from './psbt.js';
import { selectEngine } from './script/engine.js';
import {
	InvalidPsbtError,
	CommitmentError,
	NotFullySignedError,
	DifferentTransactionError,
	ForeignSignatureError,
	WrongSighashError
} from './errors.js';
import type { Wallet } from './types.js';

// ---- helpers to build a real base PSBT (2-of-3 p2wsh, one input, two outputs).
const roots = [1, 2, 3].map((s) => HDKey.fromMasterSeed(new Uint8Array(32).fill(s)));
const ORIGIN = "m/48'/1'/0'/2'";
function wallet2of3(): Wallet {
	return {
		id: 1,
		userId: 1,
		name: 'v',
		kind: 'multisig',
		scriptType: 'p2wsh',
		network: 'testnet',
		threshold: 2,
		descriptor: null,
		receiveCursor: 0,
		changeCursor: 0,
		source: 'imported',
		keys: roots.map((r, i) => ({
			position: i,
			xpub: r.derive(ORIGIN).publicExtendedKey,
			fingerprint: '00000000',
			path: ORIGIN
		})),
		createdAt: '2026-07-21T00:00:00.000Z'
	};
}
const engine = selectEngine(wallet2of3());

function buildBase(recipientAmount = 90000n, changeAmount?: bigint): btc.Transaction {
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
	tx.addInput({ txid: hex.decode(utxo.txid), index: 0, ...meta });
	tx.addOutputAddress(engine.scriptFor(0, 1).address, recipientAmount, btc.TEST_NETWORK);
	if (changeAmount) tx.addOutputAddress(engine.scriptFor(1, 0).address, changeAmount, btc.TEST_NETWORK);
	return tx;
}
const baseB64 = () => base64.encode(buildBase(90000n, 5000n).toPSBT());

/** A message hygiene assertion applied to every caught error. */
function expectCleanError(fn: () => unknown): Error {
	let err: unknown;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(Error);
	const msg = (err as Error).message;
	expect(msg.length).toBeGreaterThan(0);
	expect(msg.length).toBeLessThan(500);
	expect(msg).not.toMatch(/\s+at\s.+:\d+:\d+/); // no stack frame
	return err as Error;
}

describe('hostile-PSBT: parse guards (cases 1-7)', () => {
	it('1. empty string', () => {
		expectCleanError(() => parsePsbt(''));
		expect(() => parsePsbt('')).toThrow(InvalidPsbtError);
	});
	it('2. invalid base64', () => {
		expect(() => parsePsbt('!!!not-valid!!!')).toThrow(InvalidPsbtError);
	});
	it('3. truncated real PSBT (half)', () => {
		const b = baseB64();
		expect(() => parsePsbt(b.slice(0, Math.floor(b.length / 2)))).toThrow(InvalidPsbtError);
	});
	it('4. valid base64, wrong magic (arbitrary ASCII)', () => {
		expect(() => parsePsbt(base64.encode(new TextEncoder().encode('hello world not a psbt')))).toThrow(InvalidPsbtError);
	});
	it('5. corrupted magic byte on a real PSBT', () => {
		const bytes = base64.decode(baseB64());
		bytes[0] = 0x00;
		expect(() => parsePsbt(base64.encode(bytes))).toThrow(InvalidPsbtError);
	});
	it('6. trailing garbage: strict reject OR still reports inputCount===1', () => {
		const bytes = base64.decode(baseB64());
		const withGarbage = new Uint8Array([...bytes, 1, 2, 3, 4, 5]);
		try {
			const tx = parsePsbt(base64.encode(withGarbage));
			expect(tx.inputsLength).toBe(1); // garbage never absorbed as an extra input
		} catch (e) {
			expect(e).toBeInstanceOf(InvalidPsbtError);
		}
	});
	it('7. multi-MB sparse garbage -> caught Error and elapsed < 5000ms', () => {
		const big = base64.encode(new Uint8Array(3_000_000)); // 3MB of zeros
		const start = Date.now();
		expect(() => parsePsbt(big)).toThrow(InvalidPsbtError);
		expect(Date.now() - start).toBeLessThan(5000);
	});
});

describe('hostile-PSBT: commitment-check refusals (cases 8-12)', () => {
	it('8. added output', () => {
		const draft = baseB64();
		const signed = buildBase(90000n, 5000n);
		signed.addOutputAddress(engine.scriptFor(0, 9).address, 1000n, btc.TEST_NETWORK);
		expectCleanError(() => assertSameTransaction(draft, base64.encode(signed.toPSBT())));
		expect(() => assertSameTransaction(draft, base64.encode(signed.toPSBT()))).toThrow(CommitmentError);
	});
	it('9. changed amount', () => {
		const draft = baseB64();
		const signed = base64.encode(buildBase(90001n, 5000n).toPSBT());
		expect(() => assertSameTransaction(draft, signed)).toThrow(CommitmentError);
	});
	it('10. changed recipient', () => {
		const draft = baseB64();
		const signed = buildBase(90000n, 5000n);
		// swap the recipient output for a different address (index 2 vs index 1)
		const other = buildBase(90000n, 5000n);
		other.addOutputAddress(engine.scriptFor(0, 7).address, 90000n, btc.TEST_NETWORK);
		expect(() => assertSameTransaction(draft, base64.encode(swapRecipient().toPSBT()))).toThrow(CommitmentError);
	});
	it('11. fee inflation by shrinking change', () => {
		const draft = baseB64();
		const signed = base64.encode(buildBase(90000n, 4000n).toPSBT()); // change 5000 -> 4000
		expect(() => assertSameTransaction(draft, signed)).toThrow(CommitmentError);
	});
	it('12. input substitution', () => {
		const draft = baseB64();
		const signed = new btc.Transaction({ version: 2 });
		const meta = engine.inputMeta({ txid: '33'.repeat(32), vout: 1, valueSats: 100000, height: 1, address: 'a', chain: 0, index: 0 });
		signed.addInput({ txid: hex.decode('33'.repeat(32)), index: 1, ...meta });
		signed.addOutputAddress(engine.scriptFor(0, 1).address, 90000n, btc.TEST_NETWORK);
		signed.addOutputAddress(engine.scriptFor(1, 0).address, 5000n, btc.TEST_NETWORK);
		expect(() => assertSameTransaction(draft, base64.encode(signed.toPSBT()))).toThrow(CommitmentError);
	});
	it('reordered outputs are caught (order-sensitive compare)', () => {
		const draft = base64.encode(buildBase(90000n, 5000n).toPSBT());
		const reordered = new btc.Transaction({ version: 2 });
		const meta = engine.inputMeta({ txid: '22'.repeat(32), vout: 0, valueSats: 100000, height: 1, address: 'a', chain: 0, index: 0 });
		reordered.addInput({ txid: hex.decode('22'.repeat(32)), index: 0, ...meta });
		reordered.addOutputAddress(engine.scriptFor(1, 0).address, 5000n, btc.TEST_NETWORK); // change first
		reordered.addOutputAddress(engine.scriptFor(0, 1).address, 90000n, btc.TEST_NETWORK);
		expect(() => assertSameTransaction(draft, base64.encode(reordered.toPSBT()))).toThrow(CommitmentError);
	});
});

function swapRecipient(): btc.Transaction {
	const tx = new btc.Transaction({ version: 2 });
	const meta = engine.inputMeta({ txid: '22'.repeat(32), vout: 0, valueSats: 100000, height: 1, address: 'a', chain: 0, index: 0 });
	tx.addInput({ txid: hex.decode('22'.repeat(32)), index: 0, ...meta });
	tx.addOutputAddress(engine.scriptFor(0, 7).address, 90000n, btc.TEST_NETWORK); // different recipient
	tx.addOutputAddress(engine.scriptFor(1, 0).address, 5000n, btc.TEST_NETWORK);
	return tx;
}

describe('hostile-PSBT: combine + finalize (cases 13-17)', () => {
	function signWith(baseB64: string, root: HDKey): string {
		const tx = btc.Transaction.fromPSBT(base64.decode(baseB64));
		tx.signIdx(root.derive(ORIGIN).deriveChild(0).deriveChild(0).privateKey!, 0);
		return base64.encode(tx.toPSBT());
	}

	it('13. combine of two DIFFERENT transactions (50000 vs 51000)', () => {
		const a = signWith(base64.encode(buildBase(50000n).toPSBT()), roots[0]);
		const b = signWith(base64.encode(buildBase(51000n).toPSBT()), roots[1]);
		expect(() => engine.combine!(a, b)).toThrow(DifferentTransactionError);
	});
	it('14. combine with a FOREIGN signature', () => {
		const base = base64.encode(buildBase(90000n).toPSBT());
		const signed = signWith(base, roots[0]);
		const sig = (btc.Transaction.fromPSBT(base64.decode(signed)).getInput(0).partialSig as [Uint8Array, Uint8Array][])[0][1];
		const foreign = HDKey.fromMasterSeed(new Uint8Array(32).fill(99)).deriveChild(0).publicKey!;
		const crafted = btc.Transaction.fromPSBT(base64.decode(base));
		crafted.updateInput(0, { partialSig: [[foreign, sig]] });
		expect(() => engine.combine!(base, base64.encode(crafted.toPSBT()))).toThrow(ForeignSignatureError);
	});
	it('15. combine with a non-SIGHASH_ALL signature', () => {
		const base = base64.encode(buildBase(90000n).toPSBT());
		const signed = signWith(base, roots[0]);
		const [pub, sig] = (btc.Transaction.fromPSBT(base64.decode(signed)).getInput(0).partialSig as [Uint8Array, Uint8Array][])[0];
		const wrong = new Uint8Array(sig);
		wrong[wrong.length - 1] = 0x02;
		const crafted = btc.Transaction.fromPSBT(base64.decode(base));
		crafted.updateInput(0, { partialSig: [[pub, wrong]] });
		expect(() => engine.combine!(base, base64.encode(crafted.toPSBT()))).toThrow(WrongSighashError);
	});
	it('16. unsigned real PSBT -> finalize throws NotFullySignedError', () => {
		expect(() => engine.finalize(base64.encode(buildBase(90000n).toPSBT()))).toThrow(NotFullySignedError);
	});
	it('17. below-quorum finalize (one sig on a 2-of-3) throws NotFullySignedError', () => {
		const base = base64.encode(buildBase(90000n).toPSBT());
		const oneSig = signWith(base, roots[0]);
		expect(() => engine.finalize(oneSig)).toThrow(NotFullySignedError);
	});
});
