/**
 * T1 acceptance (MINING-ENGINE.md §9.1): known-vector tests for wire.ts,
 * ported from the Tessera pool's test/wire.spec.ts (difficultyToTarget /
 * weightForDifficulty sub-quantum edge cases) plus additional coverage the
 * spec's §9.1 bullet asks for directly: bitsToTarget, merkle branch/
 * applyBranches round-trip, toStratumPrevHash<->fromStratumPrevHash, and
 * buildHeader/headerHashDisplay on a fixed template -- verified against an
 * INDEPENDENT byte-layout re-implementation in this file (raw node:crypto),
 * not merely round-tripping wire.ts's own functions against each other, so a
 * byte-order bug in buildHeader/merkleBranches would actually be caught.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	DIFF1_TARGET,
	difficultyToTarget,
	weightForDifficulty,
	bitsToTarget,
	toStratumPrevHash,
	fromStratumPrevHash,
	displayToInternal,
	internalToDisplay,
	merkleBranches,
	applyBranches,
	buildHeader,
	headerHashDisplay,
	setHeaderNonce,
	makeLineSplitter
} from './wire.js';

function sha256(buf: Buffer): Buffer {
	return createHash('sha256').update(buf).digest();
}
function sha256d(buf: Buffer): Buffer {
	return sha256(sha256(buf));
}

describe('difficultyToTarget / weightForDifficulty', () => {
	it('maps difficulty 1 to the diff-1 target', () => {
		expect(difficultyToTarget(1)).toBe(DIFF1_TARGET);
	});

	it('a larger difficulty yields a smaller (harder) target', () => {
		expect(difficultyToTarget(2) < difficultyToTarget(1)).toBe(true);
	});

	it('rejects a non-positive difficulty', () => {
		expect(() => difficultyToTarget(0)).toThrow(/positive/);
		expect(() => difficultyToTarget(-1)).toThrow(/positive/);
	});

	it('rejects a difficulty that rounds to zero at the 1e-6 quantum with a clean error (not BigInt division-by-zero)', () => {
		expect(() => difficultyToTarget(4e-7)).toThrow(/rounds to zero/);
		expect(() => difficultyToTarget(4e-7)).not.toThrow(/Division by zero/);
		expect(() => weightForDifficulty(4e-7)).toThrow(/rounds to zero/);
	});

	it('accepts the smallest difficulty that does NOT round to zero (5e-7 → 1 unit)', () => {
		expect(difficultyToTarget(5e-7)).toBe((DIFF1_TARGET * 1_000_000n) / 1n);
		expect(weightForDifficulty(5e-7)).toBe(1n);
	});
});

describe('bitsToTarget', () => {
	it('decodes the genesis-block difficulty-1 compact bits (1d00ffff) to DIFF1_TARGET', () => {
		expect(bitsToTarget('1d00ffff')).toBe(DIFF1_TARGET);
	});

	it('rejects a non-4-byte nbits hex', () => {
		expect(() => bitsToTarget('ffff')).toThrow(/4 bytes/);
	});
});

describe('toStratumPrevHash / fromStratumPrevHash round-trip', () => {
	it('round-trips an arbitrary 32-byte display hash', () => {
		const displayHex = randomBytes(32).toString('hex');
		const stratum = toStratumPrevHash(displayHex);
		expect(fromStratumPrevHash(stratum)).toBe(displayHex);
	});

	it('rejects a non-32-byte stratum prevhash', () => {
		expect(() => fromStratumPrevHash('aa')).toThrow(/32-byte/);
	});
});

describe('displayToInternal / internalToDisplay round-trip', () => {
	it('round-trips', () => {
		const displayHex = randomBytes(32).toString('hex');
		expect(internalToDisplay(displayToInternal(displayHex))).toBe(displayHex);
	});
});

describe('merkleBranches / applyBranches', () => {
	/** Reference merkle-root computation, independent of wire.ts's own
	 *  merkleBranches/applyBranches -- pairwise sha256d, duplicating the last
	 *  hash at odd levels (Bitcoin's CVE-2012-2459-preserving convention). */
	function referenceRoot(leaves: Buffer[]): Buffer {
		let level = leaves;
		while (level.length > 1) {
			if (level.length % 2 === 1) level = [...level, level[level.length - 1]!];
			const next: Buffer[] = [];
			for (let i = 0; i < level.length; i += 2) {
				next.push(sha256d(Buffer.concat([level[i]!, level[i + 1]!])));
			}
			level = next;
		}
		return level[0]!;
	}

	it('applyBranches(coinbaseLeaf, merkleBranches(others)) equals an independently-computed root (even tx count)', () => {
		const coinbaseLeaf = randomBytes(32);
		const others = [randomBytes(32), randomBytes(32), randomBytes(32)]; // 4 leaves total
		const expected = referenceRoot([coinbaseLeaf, ...others]);
		const branches = merkleBranches(others);
		const actual = applyBranches(coinbaseLeaf, branches);
		expect(actual).toEqual(expected);
	});

	it('applyBranches(coinbaseLeaf, merkleBranches(others)) equals an independently-computed root (odd tx count, needs duplication)', () => {
		const coinbaseLeaf = randomBytes(32);
		const others = [randomBytes(32), randomBytes(32)]; // 3 leaves total (odd)
		const expected = referenceRoot([coinbaseLeaf, ...others]);
		const branches = merkleBranches(others);
		const actual = applyBranches(coinbaseLeaf, branches);
		expect(actual).toEqual(expected);
	});

	it('a coinbase-only block (no other txs) has an empty branch list and the root IS the leaf', () => {
		const coinbaseLeaf = randomBytes(32);
		const branches = merkleBranches([]);
		expect(branches).toEqual([]);
		expect(applyBranches(coinbaseLeaf, branches)).toEqual(coinbaseLeaf);
	});
});

describe('buildHeader / headerHashDisplay', () => {
	it('matches an independent byte-layout re-implementation on a fixed template', () => {
		const versionHex = '20000000';
		const prevHashDisplay = 'aa'.repeat(32);
		const merkleRootInternal = randomBytes(32);
		const ntimeHex = '5f5e1000';
		const nbitsHex = '1d00ffff';
		const nonceHex = '12345678';

		// Independent re-derivation: LE(version) ‖ internal(prevhash) ‖ merkleRoot
		// ‖ LE(ntime) ‖ LE(nbits) ‖ LE(nonce) -- reversing each BE hex field to LE
		// by hand rather than calling any wire.ts helper.
		const le4 = (hex: string) => Buffer.from(hex, 'hex').reverse();
		const prevInternal = Buffer.from(prevHashDisplay, 'hex').reverse();
		const expectedHeader = Buffer.concat([
			le4(versionHex),
			prevInternal,
			merkleRootInternal,
			le4(ntimeHex),
			le4(nbitsHex),
			le4(nonceHex)
		]);
		const expectedHash = sha256d(expectedHeader).reverse().toString('hex');

		const header = buildHeader(versionHex, prevHashDisplay, merkleRootInternal, ntimeHex, nbitsHex, nonceHex);
		expect(header).toEqual(expectedHeader);
		expect(header.length).toBe(80);
		expect(headerHashDisplay(header)).toBe(expectedHash);
	});

	it('rejects a non-80-byte header', () => {
		expect(() => headerHashDisplay(Buffer.alloc(79))).toThrow(/80 bytes/);
	});

	it('setHeaderNonce patches only the last 4 bytes, in little-endian, matching a rebuild', () => {
		const versionHex = '20000000';
		const prevHashDisplay = 'bb'.repeat(32);
		const merkleRootInternal = randomBytes(32);
		const ntimeHex = '5f5e1000';
		const nbitsHex = '1d00ffff';
		const header = buildHeader(versionHex, prevHashDisplay, merkleRootInternal, ntimeHex, nbitsHex, '00000000');
		setHeaderNonce(header, 0xdeadbeef);
		const rebuilt = buildHeader(
			versionHex,
			prevHashDisplay,
			merkleRootInternal,
			ntimeHex,
			nbitsHex,
			(0xdeadbeef).toString(16).padStart(8, '0')
		);
		expect(header).toEqual(rebuilt);
	});

	it('setHeaderNonce rejects an out-of-range nonce', () => {
		const header = Buffer.alloc(80);
		expect(() => setHeaderNonce(header, -1)).toThrow(/uint32/);
		expect(() => setHeaderNonce(header, 0x1_0000_0000)).toThrow(/uint32/);
	});
});

describe('makeLineSplitter', () => {
	it('splits newline-delimited lines, trimming and dropping empties', () => {
		const lines: string[] = [];
		const split = makeLineSplitter(
			(l) => lines.push(l),
			() => {
				throw new Error('should not overflow');
			}
		);
		split(Buffer.from('{"a":1}\n\n{"b":2}\n'));
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it('handles a line split across two chunks', () => {
		const lines: string[] = [];
		const split = makeLineSplitter(
			(l) => lines.push(l),
			() => {}
		);
		split(Buffer.from('{"a":'));
		split(Buffer.from('1}\n'));
		expect(lines).toEqual(['{"a":1}']);
	});

	it('destroys (via onOverflow) when the buffered partial line exceeds maxBuffer, never growing unbounded', () => {
		let overflowed = false;
		const split = makeLineSplitter(
			() => {},
			() => {
				overflowed = true;
			},
			16
		);
		split(Buffer.from('x'.repeat(17))); // no newline -- pending exceeds the 16-byte cap
		expect(overflowed).toBe(true);
	});
});
