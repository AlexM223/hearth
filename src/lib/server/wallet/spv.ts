/**
 * SPV tx-inclusion proof (DECISIONS.md §4.9 invariant 3; WALLET-ENGINE §5.5).
 * Pure -- no DB, no network; the caller wires the Electrum header/branch fetch.
 * Prove a tx sits in a PoW-valid block before firing a "confirmed" signal;
 * detection failure NEVER fires a false positive (fail closed).
 *
 * Checks, short-circuiting:
 *   1. height > 0                        else 'unconfirmed'
 *   2. height <= tipHeight               else 'above_tip'
 *   3. 80-byte header parses             else 'bad_header'
 *   4. header self-consistent PoW        else 'bad_pow'  (hashLE <= target(bits))
 *   5. difficulty floor (if maxTarget)   else 'weak_target'  (target(bits) > maxTarget)
 *   6. merkle proof -> header.merkleRoot else 'bad_merkle'
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';

export type SpvResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'unconfirmed' | 'above_tip' | 'bad_header' | 'bad_pow' | 'weak_target' | 'bad_merkle';
	  };

export interface TxInclusionInput {
	txid: string; // display-order hex
	height: number;
	proof: string[]; // Electrum merkle branch (display-order hex)
	pos: number; // tx position in the block
	headerHex: string; // 80-byte block header hex
	tipHeight: number;
	/** Optional difficulty floor: the max acceptable target (a hostile server can
	 *  pick a trivially-easy `bits`; the floor makes forgery cost real work). */
	maxTarget?: bigint;
}

function sha256d(data: Uint8Array): Uint8Array {
	return sha256(sha256(data));
}
function reverse(u8: Uint8Array): Uint8Array {
	return u8.slice().reverse();
}
/** Interpret 32 bytes (internal order) as a little-endian 256-bit integer. */
function leBytesToBigInt(u8: Uint8Array): bigint {
	let n = 0n;
	for (let i = u8.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(u8[i]);
	return n;
}

/** Compact `bits` -> 256-bit target (Bitcoin's nBits encoding). */
export function bitsToTarget(bits: number): bigint {
	const exponent = bits >>> 24;
	const mantissa = BigInt(bits & 0x007fffff);
	if (exponent <= 3) return mantissa >> (8n * BigInt(3 - exponent));
	return mantissa << (8n * BigInt(exponent - 3));
}

interface ParsedHeader {
	merkleRoot: Uint8Array; // internal order
	bits: number;
	hashInternal: Uint8Array; // internal order, 32 bytes
	hashLE: bigint; // block hash as a little-endian integer (for PoW compare)
}

function parseHeader(headerHex: string): ParsedHeader | null {
	let bytes: Uint8Array;
	try {
		bytes = hex.decode(headerHex.trim());
	} catch {
		return null;
	}
	if (bytes.length !== 80) return null;
	const merkleRoot = bytes.slice(36, 68); // internal order
	const bits =
		bytes[72] | (bytes[73] << 8) | (bytes[74] << 16) | (bytes[75] << 24); // LE uint32
	const hash = sha256d(bytes); // internal order
	return { merkleRoot, bits: bits >>> 0, hashInternal: hash, hashLE: leBytesToBigInt(hash) };
}

/**
 * Header fields needed OUTSIDE this module -- specifically notify/detect/
 * difficulty.ts's self-calibrating tipCache floor (WATCHTOWER.md §1.3),
 * which must reuse this module's header parsing/PoW check rather than
 * re-implement it (DECISIONS.md §4.9 invariant 3: ONE SPV implementation;
 * WATCHTOWER.md §0.3's reuse boundary, enforced by
 * notify/spvSingleSource.spec.ts).
 */
export interface ParsedBlockHeader {
	bits: number;
	/** Display-order block hash, hex (the form Electrum/explorers/tests use). */
	hash: string;
}

/** Parse an 80-byte header hex into its externally-useful fields. Returns
 *  null on anything unparseable -- callers must treat that as fail-closed
 *  (a hostile/garbled header is never a hash to trust). */
export function parseBlockHeader(headerHex: string): ParsedBlockHeader | null {
	const header = parseHeader(headerHex);
	if (!header) return null;
	return { bits: header.bits, hash: hex.encode(reverse(header.hashInternal)) };
}

/** True only when the header's own hash satisfies its own `bits` target --
 *  SELF-consistency only (an easy `bits` value still passes; that is what
 *  the difficulty floor in verifyTxInclusion/notify's tipCache is for). */
export function meetsTarget(headerHex: string): boolean {
	const header = parseHeader(headerHex);
	if (!header) return false;
	const target = bitsToTarget(header.bits);
	return target !== 0n && header.hashLE <= target;
}

/** Recompute the merkle root from a tx (display-order txid) + Electrum branch. */
function computeMerkleRoot(txid: string, proof: string[], pos: number): Uint8Array | null {
	let cur: Uint8Array;
	try {
		cur = reverse(hex.decode(txid)); // display -> internal
	} catch {
		return null;
	}
	let index = pos;
	for (const siblingHex of proof) {
		let sibling: Uint8Array;
		try {
			sibling = reverse(hex.decode(siblingHex)); // display -> internal
		} catch {
			return null;
		}
		cur = index % 2 === 0 ? sha256d(concat(cur, sibling)) : sha256d(concat(sibling, cur));
		index = Math.floor(index / 2);
	}
	return cur; // internal order
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function verifyTxInclusion(input: TxInclusionInput): SpvResult {
	if (!Number.isInteger(input.height) || input.height <= 0) return { ok: false, reason: 'unconfirmed' };
	if (input.height > input.tipHeight) return { ok: false, reason: 'above_tip' };

	const header = parseHeader(input.headerHex);
	if (!header) return { ok: false, reason: 'bad_header' };

	const target = bitsToTarget(header.bits);
	// 4. header self-consistent PoW: the block hash must meet its own target.
	if (target === 0n || header.hashLE > target) return { ok: false, reason: 'bad_pow' };

	// 5. difficulty floor: reject a trivially-easy target if a floor was given.
	if (input.maxTarget != null && target > input.maxTarget) return { ok: false, reason: 'weak_target' };

	// 6. merkle proof must reproduce the header's merkle root.
	const root = computeMerkleRoot(input.txid, input.proof, input.pos);
	if (!root || !bytesEqual(root, header.merkleRoot)) return { ok: false, reason: 'bad_merkle' };

	return { ok: true };
}
