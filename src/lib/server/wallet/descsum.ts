/**
 * BIP-380 output descriptor checksum -- Core-identical (hearth-624.12).
 *
 * Transliterated directly from the BIP-380 reference implementation
 * (github.com/bitcoin/bips/blob/master/bip-0380.mediawiki, "Checksum" section),
 * which is itself what Bitcoin Core's src/script/descriptor.cpp PolyMod is a
 * C++ port of. The character set, generator constants, and polymod below are
 * copied verbatim (translated to bigint since the accumulator needs up to 40
 * bits and JS's `<<`/`>>` operators are 32-bit only).
 *
 * The checksum is a BCH-style error-detecting code, NOT a security boundary --
 * it exists purely to catch fat-fingered/typo'd descriptors (BIP-380 "Checksum"
 * properties list). Hearth therefore:
 *  - emits a valid checksum on every descriptor it produces (buildDescriptor
 *    in import.ts), and
 *  - VALIDATES a checksum when one is present on import, rejecting a mismatch
 *    with a warm, plain-language error naming the expected checksum, but
 *  - continues to ACCEPT checksum-less imports (Core/Sparrow do the same; a
 *    missing checksum carries no typo-detection but is not a threat).
 */

const INPUT_CHARSET =
	"0123456789()[],'/*abcdefgh@:$%{}" +
	'IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~' +
	'ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';

const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

/** Internal: the BCH polymod over an array of 0-31 symbols. */
function polymod(symbols: number[]): bigint {
	let chk = 1n;
	for (const value of symbols) {
		const top = chk >> 35n;
		chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
		for (let i = 0; i < 5; i++) {
			if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
		}
	}
	return chk;
}

/** Internal: character -> symbol expansion (groups of 3 chars get a 4th
 *  "group" symbol inserted, per BIP-380). Returns null on an out-of-charset
 *  character. */
function expand(s: string): number[] | null {
	const groups: number[] = [];
	const symbols: number[] = [];
	for (const c of s) {
		const v = INPUT_CHARSET.indexOf(c);
		if (v < 0) return null;
		symbols.push(v & 31);
		groups.push(v >> 5);
		if (groups.length === 3) {
			symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
			groups.length = 0;
		}
	}
	if (groups.length === 1) {
		symbols.push(groups[0]);
	} else if (groups.length === 2) {
		symbols.push(groups[0] * 3 + groups[1]);
	}
	return symbols;
}

/** Compute the 8-character checksum for a checksum-less descriptor payload
 *  (no leading `#`, no existing checksum). Throws if `payload` contains a
 *  character outside the BIP-380 input charset. */
export function computeDescriptorChecksum(payload: string): string {
	const base = expand(payload);
	if (base === null) {
		throw new RangeError('descriptor contains a character outside the BIP-380 charset');
	}
	const symbols = base.concat([0, 0, 0, 0, 0, 0, 0, 0]);
	const checksum = polymod(symbols) ^ 1n;
	let out = '';
	for (let i = 0; i < 8; i++) {
		const idx = Number((checksum >> BigInt(5 * (7 - i))) & 31n);
		out += CHECKSUM_CHARSET[idx];
	}
	return out;
}

/** Append a freshly computed `#checksum` to a checksum-less descriptor. */
export function addDescriptorChecksum(payload: string): string {
	return `${payload}#${computeDescriptorChecksum(payload)}`;
}

/** True if `s` has the shape `...#XXXXXXXX` (a checksum candidate at the
 *  BIP-380-defined position), independent of whether it is actually valid.
 *  Used to distinguish "no checksum supplied" (accepted, per Core/Sparrow
 *  compat) from "a checksum was supplied and it's wrong" (rejected). */
export function hasChecksumSuffix(s: string): boolean {
	return s.length >= 9 && s[s.length - 9] === '#';
}

/** Verify a full `SCRIPT#CHECKSUM` string per BIP-380's descsum_check. */
export function verifyDescriptorChecksum(s: string): boolean {
	if (!hasChecksumSuffix(s)) return false;
	const checksumChars = s.slice(s.length - 8);
	for (const c of checksumChars) {
		if (!CHECKSUM_CHARSET.includes(c)) return false;
	}
	const base = expand(s.slice(0, s.length - 9));
	if (base === null) return false;
	const symbols = base.concat([...checksumChars].map((c) => CHECKSUM_CHARSET.indexOf(c)));
	return polymod(symbols) === 1n;
}

/** Split `raw` into `{ payload, checksum }` where `checksum` is the supplied
 *  8-character checksum (not yet validated) if `raw` has a checksum suffix,
 *  or `null` if it doesn't (checksum-less descriptor). */
export function splitDescriptorChecksum(raw: string): { payload: string; checksum: string | null } {
	if (hasChecksumSuffix(raw)) {
		return { payload: raw.slice(0, raw.length - 9), checksum: raw.slice(raw.length - 8) };
	}
	return { payload: raw, checksum: null };
}
