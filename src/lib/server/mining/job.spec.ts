/**
 * T2 acceptance (MINING-ENGINE.md §9.1, §2.4, §3.3): getblocktemplate ->
 * BuiltJob, the en1Offset split, and per-connection personalize(). The
 * merkle root is verified against an INDEPENDENT sha256d pairing
 * implementation (node:crypto, not wire.ts's own merkleBranches/
 * applyBranches), mirroring cairn's job.test.ts discipline.
 */
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { addressToOutputScript, networkFor } from './address.js';
import { buildJob, EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } from './job.js';
import type { GbtTemplate } from './types.js';
import { displayToInternal, fromStratumPrevHash, headerHashDisplay } from './wire.js';

const net = networkFor('regtest');
const POOL_TAG = 'hearth-solo';
const MINER_A = addressToOutputScript('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', net);
// A second, distinct payout script for the "different miners" test -- built
// directly (not via a second address string) since only its BYTES matter here.
const MINER_B = bitcoin.script.compile([bitcoin.opcodes.OP_0!, Buffer.alloc(20, 0x42)]);

function sha256(buf: Buffer): Buffer {
	return createHash('sha256').update(buf).digest();
}
function sha256dDirect(buf: Buffer): Buffer {
	return sha256(sha256(buf));
}

/** A fake but well-formed non-coinbase tx: doesn't need to be signature-valid
 *  -- buildJob treats `data` as opaque bytes and trusts the template's own
 *  `txid`, exactly like a real GBT consumer would (Core guarantees the two
 *  match; recomputing it isn't buildJob's job). */
function fakeTx(seed: number): { data: string; txid: string; hash: string } {
	const data = Buffer.alloc(40, seed).toString('hex');
	const txid = sha256dDirect(Buffer.from(data, 'hex')).toString('hex');
	return { data, txid, hash: txid };
}

const TX_A = fakeTx(1);
const TX_B = fakeTx(2);
const WITNESS_COMMITMENT = Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), Buffer.alloc(32, 0)]).toString('hex');

const TEMPLATE_2TX: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: 'ab'.repeat(32),
	height: 800000,
	curtime: 1_700_000_000,
	bits: '1d00ffff',
	coinbasevalue: 5_000_000_000,
	transactions: [TX_A, TX_B],
	default_witness_commitment: WITNESS_COMMITMENT
};

const TEMPLATE_0TX: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: 'cd'.repeat(32),
	height: 800001,
	curtime: 1_700_000_100,
	bits: '1d00ffff',
	coinbasevalue: 625_000_000
	// no transactions, no witness commitment
	,
	transactions: []
};

const EN1 = 'aabbccdd';
const EN2 = '11223344';

describe('job/buildJob: shared job fields', () => {
	it('encodes version/nbits/ntime as 8-char BE hex and prevHashStratum via the wire convention', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j1', cleanJobs: true });
		expect(built.job.versionHex).toBe('20000000');
		expect(built.job.nbitsHex).toBe('1d00ffff');
		expect(built.job.ntimeHex).toBe((1_700_000_000).toString(16));
		expect(fromStratumPrevHash(built.job.prevHashStratum)).toBe(TEMPLATE_2TX.previousblockhash);
		expect(built.job.height).toBe(800000);
		expect(built.job.coinbaseValueSats).toBe(5_000_000_000n);
		expect(built.job.cleanJobs).toBe(true);
	});

	it('rejects an out-of-range height', () => {
		expect(() =>
			buildJob({ ...TEMPLATE_2TX, height: -1 }, { network: net, poolTag: POOL_TAG, jobId: 'j', cleanJobs: true })
		).toThrow(/out of range/);
	});
});

describe('job/buildJob: personalize() — per-miner coinbase', () => {
	function reassembledCoinbase(coinb1Hex: string, coinb2Hex: string): Buffer {
		return Buffer.concat([Buffer.from(coinb1Hex, 'hex'), Buffer.from(EN1, 'hex'), Buffer.from(EN2, 'hex'), Buffer.from(coinb2Hex, 'hex')]);
	}

	it('2-tx template: single payout output = full coinbasevalue, + zero-value witness commitment', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j1', cleanJobs: true });
		const variant = built.personalize({ payoutScript: MINER_A });
		expect(variant.coinb1Hex.length % 2).toBe(0);
		const raw = reassembledCoinbase(variant.coinb1Hex, variant.coinb2Hex);
		const parsed = bitcoin.Transaction.fromHex(raw.toString('hex'));
		expect(parsed.outs).toHaveLength(2);
		expect(BigInt(parsed.outs[0]!.value)).toBe(5_000_000_000n);
		expect(parsed.outs[0]!.script.equals(Buffer.from(MINER_A))).toBe(true);
		expect(parsed.outs[1]!.value).toBe(0);
		expect(parsed.outs[1]!.script.toString('hex')).toBe(WITNESS_COMMITMENT);
	});

	it('0-tx template: a single payout output, no witness commitment', () => {
		const built = buildJob(TEMPLATE_0TX, { network: net, poolTag: POOL_TAG, jobId: 'j2', cleanJobs: true });
		const variant = built.personalize({ payoutScript: MINER_A });
		const raw = reassembledCoinbase(variant.coinb1Hex, variant.coinb2Hex);
		const parsed = bitcoin.Transaction.fromHex(raw.toString('hex'));
		expect(parsed.outs).toHaveLength(1);
		expect(BigInt(parsed.outs[0]!.value)).toBe(625_000_000n);
	});

	it('merkle root matches an INDEPENDENT sha256d pairing of the coinbase txid + the two other txids', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j3', cleanJobs: true });
		const variant = built.personalize({ payoutScript: MINER_A });
		const raw = reassembledCoinbase(variant.coinb1Hex, variant.coinb2Hex);
		const coinbaseTxidLE = sha256dDirect(raw); // internal (LE) order — same as wire.ts

		const leafA = displayToInternal(TX_A.txid);
		const leafB = displayToInternal(TX_B.txid);
		// Reference: level1 = [h(coinbase,A), h(B,B) dup] ; root = h(level1[0], level1[1])
		const h01 = sha256dDirect(Buffer.concat([coinbaseTxidLE, leafA]));
		const h23 = sha256dDirect(Buffer.concat([leafB, leafB])); // odd count at this level → duplicate last
		const expectedRoot = sha256dDirect(Buffer.concat([h01, h23]));

		const header = variant.headerFor(EN1, EN2, built.job.ntimeHex, '00000000');
		// header layout: version(4) ‖ prevhash(32) ‖ merkleRoot(32) ‖ ntime(4) ‖ nbits(4) ‖ nonce(4)
		const merkleRootInHeader = header.subarray(36, 68);
		expect(merkleRootInHeader).toEqual(expectedRoot);
	});

	it('headerFor and assemble agree on the block hash', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j4', cleanJobs: true });
		const variant = built.personalize({ payoutScript: MINER_A });
		const header = variant.headerFor(EN1, EN2, built.job.ntimeHex, 'deadbeef');
		const assembled = variant.assemble(EN1, EN2, built.job.ntimeHex, 'deadbeef');
		expect(assembled.blockHashDisplay).toBe(headerHashDisplay(header));
	});

	it('assemble concatenates header ‖ tx-count varint ‖ witnessed coinbase ‖ every other raw tx', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j5', cleanJobs: true });
		const variant = built.personalize({ payoutScript: MINER_A });
		const assembled = variant.assemble(EN1, EN2, built.job.ntimeHex, '00000001');
		const blockBuf = Buffer.from(assembled.blockHex, 'hex');
		// After the 80-byte header + 1-byte tx-count varint (3 txs: coinbase+2 < 0xfd),
		// the raw tx bytes for TX_A and TX_B must appear verbatim, in template order.
		const tail = blockBuf.subarray(blockBuf.length - (40 + 40)); // fakeTx() data is 40 bytes each
		expect(tail.subarray(0, 40).toString('hex')).toBe(TX_A.data);
		expect(tail.subarray(40, 80).toString('hex')).toBe(TX_B.data);
	});

	it('different payout scripts produce different coinb2 and a different block hash for the same nonce', () => {
		const built = buildJob(TEMPLATE_2TX, { network: net, poolTag: POOL_TAG, jobId: 'j6', cleanJobs: true });
		const a = built.personalize({ payoutScript: MINER_A });
		const b = built.personalize({ payoutScript: MINER_B });
		expect(a.coinb2Hex).not.toBe(b.coinb2Hex);
		const ha = a.headerFor(EN1, EN2, built.job.ntimeHex, '00000001');
		const hb = b.headerFor(EN1, EN2, built.job.ntimeHex, '00000001');
		expect(ha.equals(hb)).toBe(false);
	});

	it('extranonce sizes are 4 bytes each (8 hex chars total split point)', () => {
		expect(EXTRANONCE1_SIZE).toBe(4);
		expect(EXTRANONCE2_SIZE).toBe(4);
	});
});
