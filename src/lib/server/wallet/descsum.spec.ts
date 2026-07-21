/**
 * BIP-380 descriptor checksum (hearth-624.12).
 *
 * Test vectors: the BIP-380 spec text itself (github.com/bitcoin/bips/blob/
 * master/bip-0380.mediawiki, "Test Vectors" section) ships exactly ONE
 * checksum test vector: `raw(deadbeef)#89f8spxm`, plus a handful of malformed-
 * shape variants of it. There is no separate cache of "11 oracle vectors" in
 * this repo -- searched .beads/issues.jsonl (all revisions, incl.
 * .br_history/), git log/show across every commit mentioning "checksum" or
 * "oracle", and comments on hearth-624.12/hearth-624.4 (T3): none contain
 * additional vectors. hearth-624.4's actual T3 commit (9b16d65) shipped
 * import.ts checksum-less with no vector data recorded anywhere.
 *
 * So this suite is anchored on the ONE real spec vector (proves the
 * polymod/generator/charset transliteration is byte-for-byte correct against
 * Core's own algorithm, since Core's PolyMod is a direct port of this same
 * reference code), plus round-trip + mutation coverage generated from that
 * verified-correct implementation.
 */
import { describe, expect, it } from 'vitest';
import {
	addDescriptorChecksum,
	computeDescriptorChecksum,
	verifyDescriptorChecksum,
	splitDescriptorChecksum,
	hasChecksumSuffix
} from './descsum.js';

describe('BIP-380 spec vector (github.com/bitcoin/bips bip-0380.mediawiki)', () => {
	it('computes the exact checksum for raw(deadbeef)', () => {
		expect(computeDescriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
	});

	it('addDescriptorChecksum reproduces the spec string exactly', () => {
		expect(addDescriptorChecksum('raw(deadbeef)')).toBe('raw(deadbeef)#89f8spxm');
	});

	it('accepts the valid checksum', () => {
		expect(verifyDescriptorChecksum('raw(deadbeef)#89f8spxm')).toBe(true);
	});

	it('rejects a payload error (deadbeef -> deedbeef) under the original checksum', () => {
		expect(verifyDescriptorChecksum('raw(deedbeef)#89f8spxm')).toBe(false);
	});

	it('rejects a checksum error (## instead of #8)', () => {
		expect(verifyDescriptorChecksum('raw(deadbeef)##9f8spxm')).toBe(false);
	});

	it('rejects a missing checksum (bare #)', () => {
		expect(verifyDescriptorChecksum('raw(deadbeef)#')).toBe(false);
	});

	it('rejects a too-long checksum (9 chars)', () => {
		expect(verifyDescriptorChecksum('raw(deadbeef)#89f8spxmx')).toBe(false);
	});

	it('rejects a too-short checksum (7 chars)', () => {
		expect(verifyDescriptorChecksum('raw(deadbeef)#89f8spx')).toBe(false);
	});

	it('a checksum-less string has no checksum suffix at all', () => {
		expect(hasChecksumSuffix('raw(deadbeef)')).toBe(false);
		expect(verifyDescriptorChecksum('raw(deadbeef)')).toBe(false);
	});

	it('rejects invalid (non-charset) characters in the payload', () => {
		expect(() => computeDescriptorChecksum('raw(Ü)')).toThrow(RangeError);
	});
});

describe('splitDescriptorChecksum', () => {
	it('splits payload and checksum when a checksum suffix is present', () => {
		expect(splitDescriptorChecksum('raw(deadbeef)#89f8spxm')).toEqual({
			payload: 'raw(deadbeef)',
			checksum: '89f8spxm'
		});
	});

	it('returns the whole string as payload with a null checksum when absent', () => {
		expect(splitDescriptorChecksum('raw(deadbeef)')).toEqual({
			payload: 'raw(deadbeef)',
			checksum: null
		});
	});
});

describe('roundtrip property: emit -> validate for realistic wallet descriptors', () => {
	const samples = [
		"wpkh([73c5da0a/84h/0h/0h]xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)",
		'wsh(sortedmulti(2,[73c5da0a/48h/0h/0h/2h]xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/0/*,[aabbccdd/48h/0h/0h/2h]xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/0/*))',
		'pkh(xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/1/*)',
		'sh(wpkh(xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/0/*))'
	];

	for (const s of samples) {
		it(`round-trips: ${s.slice(0, 24)}...`, () => {
			const full = addDescriptorChecksum(s);
			expect(verifyDescriptorChecksum(full)).toBe(true);
			expect(full.startsWith(s + '#')).toBe(true);
		});
	}
});

describe('mutation tests: single-character typos are always detected', () => {
	const base = 'wpkh([73c5da0a/84h/0h/0h]xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)';
	const full = addDescriptorChecksum(base);
	const [payload, checksum] = [base, full.slice(full.length - 8)];

	it('sanity: the unmutated string is valid', () => {
		expect(verifyDescriptorChecksum(full)).toBe(true);
	});

	it('detects a single substituted character anywhere in the payload', () => {
		for (let i = 0; i < payload.length; i++) {
			// Swap position i for a different, still-in-charset character.
			const orig = payload[i];
			const replacement = orig === '0' ? '1' : '0';
			const mutated = payload.slice(0, i) + replacement + payload.slice(i + 1) + '#' + checksum;
			if (payload[i] === replacement) continue; // no-op guard
			expect(verifyDescriptorChecksum(mutated)).toBe(false);
		}
	});

	it('detects a single substituted character anywhere in the checksum', () => {
		const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
		for (let i = 0; i < checksum.length; i++) {
			const orig = checksum[i];
			const replacement = charset[0] === orig ? charset[1] : charset[0];
			const mutatedChecksum = checksum.slice(0, i) + replacement + checksum.slice(i + 1);
			const mutated = payload + '#' + mutatedChecksum;
			expect(verifyDescriptorChecksum(mutated)).toBe(false);
		}
	});

	it('detects a transposition of two adjacent checksum characters', () => {
		for (let i = 0; i < checksum.length - 1; i++) {
			if (checksum[i] === checksum[i + 1]) continue;
			const mutatedChecksum =
				checksum.slice(0, i) + checksum[i + 1] + checksum[i] + checksum.slice(i + 2);
			const mutated = payload + '#' + mutatedChecksum;
			expect(verifyDescriptorChecksum(mutated)).toBe(false);
		}
	});
});
