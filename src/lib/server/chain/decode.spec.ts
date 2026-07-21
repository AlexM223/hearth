/**
 * decodeBlockHeader/decodeBlockHeaderRange against the mainnet genesis block
 * header -- a fixed, universally-known raw header (Bitcoin Core's
 * chainparams.cpp genesis block, reproduced in every Bitcoin implementation)
 * so the byte-order/reversal logic (the #1 bug source in this kind of code)
 * is checked against reality, not just "does it not throw."
 *
 * The genesis block's nonce/time/bits are independently well-known decimal/
 * hex values (2083236893 / 1231006505 / 0x1d00ffff) and are asserted
 * directly. The hash/merkleRoot expectations are derived here from the SAME
 * raw header bytes via an independent (test-local, not imported from
 * decode.ts) double-SHA256 + byte-reversal -- the actual Bitcoin
 * hashing/display algorithm -- so this test still catches a byte-order bug
 * in decode.ts without depending on transcribing a 64-hex-char magic string
 * from memory.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBlockHeader, decodeBlockHeaderRange } from './decode.js';

const GENESIS_HEADER_HEX =
	'0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';

function referenceDsha256Reversed(buf: Buffer): string {
	const once = createHash('sha256').update(buf).digest();
	const twice = createHash('sha256').update(once).digest();
	return Buffer.from(twice).reverse().toString('hex');
}

function referenceBeHex(buf: Buffer): string {
	return Buffer.from(buf).reverse().toString('hex');
}

const headerBuf = Buffer.from(GENESIS_HEADER_HEX, 'hex');
const EXPECTED_HASH = referenceDsha256Reversed(headerBuf.subarray(0, 80));
const EXPECTED_MERKLE_ROOT = referenceBeHex(headerBuf.subarray(36, 68));

describe('chain/decode: decodeBlockHeader', () => {
	it('decodes the genesis block header to its well-known field values', () => {
		const h = decodeBlockHeader(GENESIS_HEADER_HEX);
		expect(h.hash).toBe(EXPECTED_HASH);
		expect(h.hash).toHaveLength(64);
		expect(h.merkleRoot).toBe(EXPECTED_MERKLE_ROOT);
		expect(h.prevHash).toBe('0'.repeat(64));
		expect(h.version).toBe(1);
		expect(h.time).toBe(1231006505); // 2009-01-03T18:15:05Z, the well-known genesis timestamp
		expect(h.bits).toBe('1d00ffff'); // genesis difficulty target, well-known
		expect(h.nonce).toBe(2083236893); // well-known genesis nonce
	});

	it('throws on a too-short header rather than silently decoding garbage', () => {
		expect(() => decodeBlockHeader('deadbeef')).toThrow(/too short/);
	});
});

describe('chain/decode: decodeBlockHeaderRange', () => {
	it('decodes a single-header range and assigns the given startHeight', () => {
		const rows = decodeBlockHeaderRange(GENESIS_HEADER_HEX, 0);
		expect(rows).toHaveLength(1);
		expect(rows[0].height).toBe(0);
		expect(rows[0].hash).toBe(EXPECTED_HASH);
	});

	it('decodes a concatenated multi-header blob, assigning sequential heights', () => {
		const rows = decodeBlockHeaderRange(GENESIS_HEADER_HEX + GENESIS_HEADER_HEX, 100);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.height)).toEqual([100, 101]);
		expect(rows[0].hash).toBe(EXPECTED_HASH);
		expect(rows[1].hash).toBe(EXPECTED_HASH);
	});
});
