/**
 * Shared byte-decoding helpers (EXPLORER.md §1.1): nBits, raw header bytes.
 * Kept out of blocks.ts/tx.ts's own rail-selection logic by design -- the
 * one thing this doc explicitly designs against is cairn's 2,167-line
 * everything-in-one-file `chain/index.ts`.
 */
import { createHash } from 'node:crypto';

const HEADER_BYTES = 80;

function dsha256(buf: Buffer): Buffer {
	return createHash('sha256').update(createHash('sha256').update(buf).digest()).digest();
}

/** Bitcoin's hash/prevhash/merkleroot/bits display convention: the raw
 *  little-endian wire bytes, byte-reversed, then hex-encoded. */
function beHex(buf: Buffer): string {
	return Buffer.from(buf).reverse().toString('hex');
}

export interface DecodedHeader {
	hash: string;
	version: number;
	prevHash: string;
	merkleRoot: string;
	time: number;
	bits: string;
	nonce: number;
}

/** Decodes one raw 80-byte Bitcoin block header (as returned by Electrum's
 *  `blockchain.block.header[s]`) into the same field shapes Core's JSON RPC
 *  uses (hash/bits as byte-reversed hex, matching `getblockheader`'s output). */
export function decodeBlockHeader(hex: string): DecodedHeader {
	const buf = Buffer.from(hex, 'hex');
	if (buf.length < HEADER_BYTES) throw new Error(`block header too short: ${buf.length} bytes`);
	const header = buf.subarray(0, HEADER_BYTES);
	return {
		hash: beHex(dsha256(header)),
		version: header.readInt32LE(0),
		prevHash: beHex(header.subarray(4, 36)),
		merkleRoot: beHex(header.subarray(36, 68)),
		time: header.readUInt32LE(68),
		bits: beHex(header.subarray(72, 76)),
		nonce: header.readUInt32LE(76)
	};
}

/** Decodes a concatenated blob of `count` 80-byte headers (Electrum's
 *  `blockchain.block.headers` range call) into per-height rows. */
export function decodeBlockHeaderRange(hex: string, startHeight: number): (DecodedHeader & { height: number })[] {
	const buf = Buffer.from(hex, 'hex');
	const count = Math.floor(buf.length / HEADER_BYTES);
	const out: (DecodedHeader & { height: number })[] = [];
	for (let i = 0; i < count; i++) {
		const chunk = buf.subarray(i * HEADER_BYTES, (i + 1) * HEADER_BYTES);
		out.push({ ...decodeBlockHeader(chunk.toString('hex')), height: startHeight + i });
	}
	return out;
}
