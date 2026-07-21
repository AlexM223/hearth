/**
 * T1 acceptance (WATCHTOWER.md §1.3): the tipCache accepts self-consistent
 * headers, rejects PoW-inconsistent/unparseable ones, rejects an implausibly
 * weak header relative to the hardest target already held (a hostile server
 * priming the cache), prunes to TIP_CACHE_SIZE, and reset() clears everything
 * for an Electrum client swap.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { createDifficultyFloor, TIP_CACHE_SIZE, DIFFICULTY_FLOOR_FACTOR } from './difficulty.js';

// The same real, PoW-valid mainnet block-700000 header used by wallet/spv.spec.ts.
const REAL_HEADER =
	'04e0ff3feb36c62f0471cee034811019e43b14f459b50e00cea30a000000000000000000659cecf4a06ed500031b741384e87d40ce5c16c3ec8c09b09ffe4b863c218d1f282d3c61e4480f17d767c2ab';
const REAL_HEIGHT = 700000;

/** A synthetic-but-self-consistent header: bits encodes a target so huge that
 *  ANY 32-byte hash satisfies it, so varying `seedByte` (part of the "nonce")
 *  deterministically produces a distinct, always-PoW-valid header WITHOUT
 *  needing real mining. Exponent 0x20 (32) with a near-max mantissa covers
 *  the entire practical 256-bit hash space. */
function trivialHeader(seedByte: number): string {
	const bytes = new Uint8Array(80);
	bytes.fill(seedByte % 256);
	// bits at offset 72..75 (LE): exponent=0x22, mantissa=0x7fffff -> target =
	// 0x7fffff << (8*31) ~= 2^271, which EXCEEDS the entire 256-bit hash space
	// (2^256-1) -- every possible hash satisfies it, so self-consistency is
	// unconditionally guaranteed (no mining/brute-force needed).
	bytes[72] = 0xff;
	bytes[73] = 0xff;
	bytes[74] = 0x7f;
	bytes[75] = 0x22;
	return hex.encode(bytes);
}

describe('T1: createDifficultyFloor (the self-calibrating SPV floor)', () => {
	it('accepts a real PoW-valid header and reports it back', () => {
		const floor = createDifficultyFloor();
		expect(floor.acceptHeader(REAL_HEIGHT, REAL_HEADER)).toBe(true);
		expect(floor.size()).toBe(1);
		expect(floor.tipHeight()).toBe(REAL_HEIGHT);
		expect(floor.cachedHeader(REAL_HEIGHT)).toBeDefined();
		expect(floor.maxTarget() > 0n).toBe(true);
	});

	it('rejects an unparseable header', () => {
		const floor = createDifficultyFloor();
		expect(floor.acceptHeader(1, 'deadbeef')).toBe(false);
		expect(floor.size()).toBe(0);
	});

	it('rejects a header whose hash does not satisfy its own bits (tampered)', () => {
		const floor = createDifficultyFloor();
		const bytes = hex.decode(REAL_HEADER);
		bytes[76] ^= 0xff; // flip a nonce byte -> hash changes, bits (real, hard) does not
		expect(floor.acceptHeader(REAL_HEIGHT, hex.encode(bytes))).toBe(false);
		expect(floor.size()).toBe(0);
	});

	it('maxTarget() reports the hardest (numerically SMALLEST) target, not the largest', () => {
		const floor = createDifficultyFloor();
		floor.acceptHeader(REAL_HEIGHT, REAL_HEADER); // a genuinely hard (small target) header
		const hardTarget = floor.maxTarget();
		// A trivially-weak (huge target) header is rejected outright once a hard
		// floor exists (see the next test) -- so the recorded "hardest" value
		// must stay the REAL header's small target, never grow to the weak one.
		floor.acceptHeader(REAL_HEIGHT + 1, trivialHeader(1));
		expect(floor.maxTarget()).toBe(hardTarget);
		expect(floor.maxTarget()).toBeLessThan(1n << 250n); // a real mainnet target is nowhere near the 256-bit ceiling
	});

	it('rejects an implausibly weak header relative to the hardest target already held (hostile cache-priming)', () => {
		const floor = createDifficultyFloor();
		floor.acceptHeader(REAL_HEIGHT, REAL_HEADER);
		const priorMax = floor.maxTarget();
		const accepted = floor.acceptHeader(REAL_HEIGHT + 1, trivialHeader(2));
		expect(accepted).toBe(false);
		expect(floor.maxTarget()).toBe(priorMax); // unchanged
	});

	it('accepts a trivial header fine when the cache starts empty (no prior floor to violate)', () => {
		const floor = createDifficultyFloor();
		expect(floor.acceptHeader(1, trivialHeader(5))).toBe(true);
		expect(floor.size()).toBe(1);
	});

	it('prunes to TIP_CACHE_SIZE, keeping the newest heights', () => {
		const floor = createDifficultyFloor();
		for (let h = 1; h <= TIP_CACHE_SIZE + 10; h++) {
			expect(floor.acceptHeader(h, trivialHeader(h))).toBe(true);
		}
		expect(floor.size()).toBe(TIP_CACHE_SIZE);
		expect(floor.cachedHeader(1)).toBeUndefined(); // pruned (oldest)
		expect(floor.cachedHeader(TIP_CACHE_SIZE + 10)).toBeDefined(); // kept (newest)
		expect(floor.tipHeight()).toBe(TIP_CACHE_SIZE + 10);
	});

	it('reset() clears the cache and tip height (Electrum client swap)', () => {
		const floor = createDifficultyFloor();
		floor.acceptHeader(REAL_HEIGHT, REAL_HEADER);
		floor.reset();
		expect(floor.size()).toBe(0);
		expect(floor.tipHeight()).toBe(0);
		expect(floor.maxTarget()).toBe(0n);
	});

	it('DIFFICULTY_FLOOR_FACTOR is the documented constant (4n)', () => {
		expect(DIFFICULTY_FLOOR_FACTOR).toBe(4n);
	});
});
