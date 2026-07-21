/**
 * Shared wire/byte-order primitives for the solo mining engine's job builder,
 * Stratum server, and the forced-solve QA driver's synthetic miner. EVERY
 * byte-order decision lives here and nowhere else -- the server and the
 * miner must import these, never reimplement them, so the two sides cannot
 * disagree (MINING-ENGINE.md §1.1, §2.4).
 *
 * PORTED NEAR-VERBATIM from the Tessera pool (C:\dev\raffle\pool\src\wire.ts,
 * via cairn's C:\dev\cairn\src\lib\server\mining\wire.ts): this is
 * consensus-critical byte math and is never re-derived. Only header comments
 * differ from the source.
 *
 * Conventions:
 *  - "display" hex = the hash string Bitcoin Core shows (big-endian display).
 *  - "internal" / LE = the byte order used inside headers and merkle math
 *    (reverse of display).
 *  - Stratum prevhash = internal bytes with each 4-byte word byte-swapped
 *    (the de-facto Stratum V1 convention).
 */
import { createHash } from 'node:crypto';

export function sha256d(buf: Buffer): Buffer {
	const a = createHash('sha256').update(buf).digest();
	return createHash('sha256').update(a).digest();
}

export function reverseBytes(buf: Buffer): Buffer {
	return Buffer.from(buf).reverse();
}

/** Display hex (Core's getblockhash output) -> internal 32-byte LE buffer. */
export function displayToInternal(displayHex: string): Buffer {
	const b = Buffer.from(displayHex, 'hex');
	if (b.length !== 32) throw new Error('expected 32-byte hash hex');
	return reverseBytes(b);
}

export function internalToDisplay(internal: Buffer): string {
	if (internal.length !== 32) throw new Error('expected 32-byte hash');
	return reverseBytes(internal).toString('hex');
}

export function varint(n: number): Buffer {
	if (n < 0xfd) return Buffer.from([n]);
	if (n <= 0xffff) {
		const b = Buffer.alloc(3);
		b[0] = 0xfd;
		b.writeUInt16LE(n, 1);
		return b;
	}
	const b = Buffer.alloc(5);
	b[0] = 0xfe;
	b.writeUInt32LE(n, 1);
	return b;
}

/** Compact-bits (nbits, BE hex like "207fffff") -> 256-bit target. */
export function bitsToTarget(nbitsHex: string): bigint {
	const bits = Buffer.from(nbitsHex, 'hex');
	if (bits.length !== 4) throw new Error('nbits must be 4 bytes hex');
	const exponent = bits[0]!;
	const mantissa = BigInt('0x' + bits.subarray(1).toString('hex'));
	return exponent <= 3
		? mantissa >> (8n * BigInt(3 - exponent))
		: mantissa << (8n * BigInt(exponent - 3));
}

/** Standard pool difficulty-1 target. */
export const DIFF1_TARGET = 0xffffn << 208n;

/** Pool share difficulty (may be fractional) -> share target. */
export function difficultyToTarget(difficulty: number): bigint {
	if (!(difficulty > 0)) throw new Error('difficulty must be positive');
	const scaled = BigInt(Math.round(difficulty * 1e6));
	// A difficulty that rounds to zero at the 1e-6 quantum (e.g. < 5e-7) would
	// divide by zero below. Reject it cleanly -- mirroring weightForDifficulty's
	// guard -- instead of leaking a cryptic BigInt "Division by zero" RangeError.
	if (scaled <= 0n) throw new Error('difficulty rounds to zero — raise difficulty or scale');
	return (DIFF1_TARGET * 1_000_000n) / scaled;
}

/**
 * Engine ticket weight for a share at a given pool difficulty (weight = share
 * difficulty, as an integer). Fractional pool difficulties are scaled by a
 * constant; the scale cancels in any uniform accounting.
 */
export const SHARE_WEIGHT_SCALE = 1_000_000;
export function weightForDifficulty(difficulty: number): bigint {
	const w = BigInt(Math.round(difficulty * SHARE_WEIGHT_SCALE));
	if (w <= 0n) throw new Error('weight rounds to zero — raise difficulty or scale');
	return w;
}

/** Numeric value of a block/share hash (display-hex interpretation). */
export function hashValueFromDisplay(displayHex: string): bigint {
	return BigInt('0x' + displayHex);
}

function swap32(buf: Buffer): Buffer {
	if (buf.length % 4 !== 0) throw new Error('length not multiple of 4');
	const out = Buffer.alloc(buf.length);
	for (let i = 0; i < buf.length; i += 4) {
		out[i] = buf[i + 3]!;
		out[i + 1] = buf[i + 2]!;
		out[i + 2] = buf[i + 1]!;
		out[i + 3] = buf[i]!;
	}
	return out;
}

/** Display hash -> Stratum prevhash field (internal bytes, 4-byte words swapped). */
export function toStratumPrevHash(displayHex: string): string {
	return swap32(displayToInternal(displayHex)).toString('hex');
}

export function fromStratumPrevHash(stratumHex: string): string {
	const b = Buffer.from(stratumHex, 'hex');
	if (b.length !== 32) throw new Error('expected 32-byte prevhash');
	return internalToDisplay(swap32(b));
}

/**
 * Build the 80-byte block header. version/ntime/nbits/nonce arrive as
 * BE hex strings (8 hex chars) exactly as carried in Stratum messages.
 */
export function buildHeader(
	versionHex: string,
	prevHashDisplay: string,
	merkleRootInternal: Buffer,
	ntimeHex: string,
	nbitsHex: string,
	nonceHex: string
): Buffer {
	const le4 = (hex: string) => {
		const b = Buffer.from(hex, 'hex');
		if (b.length !== 4) throw new Error(`expected 4-byte BE hex, got ${hex}`);
		return reverseBytes(b);
	};
	if (merkleRootInternal.length !== 32) throw new Error('merkle root must be 32 bytes');
	return Buffer.concat([
		le4(versionHex),
		displayToInternal(prevHashDisplay),
		merkleRootInternal,
		le4(ntimeHex),
		le4(nbitsHex),
		le4(nonceHex)
	]);
}

export function headerHashDisplay(header80: Buffer): string {
	if (header80.length !== 80) throw new Error('header must be 80 bytes');
	return internalToDisplay(sha256d(header80));
}

/**
 * Patch the nonce field of an 80-byte header IN PLACE (bytes 76..80,
 * little-endian -- exactly the byte order buildHeader writes). Lets a miner
 * build the header once per (job, extranonce2) -- version/prevhash/merkle
 * root/ntime/nbits are all fixed for a whole nonce sweep -- and rewrite only
 * these 4 bytes per hash. Equivalent to rebuilding the header with
 * buildHeader(..., nonce.toString(16).padStart(8, '0')).
 */
export function setHeaderNonce(header80: Buffer, nonce: number): void {
	if (header80.length !== 80) throw new Error('header must be 80 bytes');
	if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
		throw new Error(`nonce must be a uint32, got ${nonce}`);
	}
	header80.writeUInt32LE(nonce, 76);
}

/**
 * Stratum merkle branches for the coinbase (leaf index 0).
 * Input: txids of all NON-coinbase transactions, internal byte order,
 * in template order. Apply with applyBranches(coinbaseTxidLE, branches).
 */
export function merkleBranches(otherTxidsInternal: readonly Buffer[]): Buffer[] {
	const branches: Buffer[] = [];
	// hashes[0] is the coinbase placeholder (null) -- its value is folded in later.
	let hashes: (Buffer | null)[] = [null, ...otherTxidsInternal];
	while (hashes.length > 1) {
		if (hashes.length % 2 === 1) hashes.push(hashes[hashes.length - 1]!);
		branches.push(hashes[1]!);
		const next: (Buffer | null)[] = [null];
		for (let i = 2; i < hashes.length; i += 2) {
			next.push(sha256d(Buffer.concat([hashes[i]!, hashes[i + 1]!])));
		}
		hashes = next;
	}
	return branches;
}

export function applyBranches(leafInternal: Buffer, branches: readonly Buffer[]): Buffer {
	let root = leafInternal;
	for (const b of branches) root = sha256d(Buffer.concat([root, b]));
	return root;
}

/**
 * Newline-delimited JSON framing with a per-connection buffer cap
 * (cap every connection buffer; kill on overflow -- MINING-ENGINE.md §2.1/§7).
 */
export function makeLineSplitter(
	onLine: (line: string) => void,
	onOverflow: () => void,
	maxBuffer = 16 * 1024
): (chunk: Buffer) => void {
	let pending = '';
	return (chunk: Buffer) => {
		pending += chunk.toString('utf8');
		if (pending.length > maxBuffer) {
			onOverflow();
			pending = '';
			return;
		}
		let idx: number;
		while ((idx = pending.indexOf('\n')) >= 0) {
			const line = pending.slice(0, idx).trim();
			pending = pending.slice(idx + 1);
			if (line.length > 0) onLine(line);
		}
	};
}
