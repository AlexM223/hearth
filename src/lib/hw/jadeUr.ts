/**
 * BC-UR (Blockchain Commons Uniform Resources) crypto-psbt codec for
 * air-gapped QR transfer to a Blockstream Jade in its native "QR" mode, or a
 * Keystone (SIGNING.md §1.7). Pure, DOM-free, BROWSER-SIDE ONLY -- mirrors
 * bbqr.ts's public API (`encodePsbtToFrames` / a `PsbtQrJoiner`-shaped
 * assembler) so `SignWithQr.svelte` can swap codecs by import alone.
 *
 * Ported as a PATTERN from `C:\dev\cairn\src\lib\hw\jadeUr.ts` (never copied):
 * the bytewords alphabet, minimal-CBOR framing, and multipart layout below
 * are taken verbatim from the BC-UR reference implementation
 * (`@ngraveio/bc-ur` v1.1.13) so what this emits is byte-identical to a stock
 * BC-UR encoder, and what it accepts is what a real Jade/Keystone produces.
 *
 * ---- Library decision (hearth-ui7, T8 re-scoped) --------------------------
 * This module deliberately hand-rolls the codec instead of taking an npm BC-UR
 * dependency (`bc-ur`, or `@keystonehq/bc-ur-registry` over `@ngraveio/bc-ur`).
 * SIGNING.md §1.7 already calls for this; cairn's own jadeUr.ts independently
 * reached and shipped the same conclusion. The crypto-psbt payload is trivial
 * (BCR-2020-004: a CBOR byte string wrapping the raw PSBT bytes) and every
 * layer involved (BCR-2020-005 multipart UR, BCR-2020-006 bytewords) is fully
 * specified, so a small self-contained implementation is lower risk than a
 * dependency with a documented history of Node-Buffer/CBOR/jsbi
 * browser-bundling friction, for a feature this narrow. This is a SEPARATE
 * call from Stage 3's live Jade (Web Serial / `jadets`) driver, which
 * hearth-ui7 assessed and declined to build (unofficial, single-maintainer,
 * a confirmed unfixed bug in the exact multi-chunk signing path, and real
 * Node-builtin browser-bundling breakage beyond what the devDependency
 * strategy covers) -- this codec has none of those problems: it is Hearth's
 * own code, zero new runtime dependencies (`@scure/base`, already a
 * production dep, for base64), and gives Jade/Keystone owners an air-gapped
 * signing path that never touches jadets or Web Serial at all.
 */
import { base64 } from '@scure/base';

const UR_TYPE = 'crypto-psbt';
const UR_HEADER = `ur:${UR_TYPE}/`;

// ---- CRC-32 (IEEE, reflected) ----------------------------------------------
// BC-UR appends a CRC-32 of the payload to every bytewords string and carries
// the CRC-32 of the whole CBOR message as the multipart `checksum` field.
const CRC32_TABLE = /* @__PURE__ */ (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
	return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

// ---- Bytewords (BCR-2020-006, "minimal" style) -----------------------------
// The canonical 256 four-letter bytewords, concatenated (word i = slice i*4).
// Verbatim from @ngraveio/bc-ur v1.1.13 bytewords.ts. The MINIMAL encoding a
// UR uses emits just the first + last letter of each word, no separators,
// plus a 4-byte CRC-32 (as 4 more codes) appended over the payload.
const BYTEWORDS =
	'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

const BYTEWORD_LENGTH = 4;

function minimalCode(byte: number): string {
	const w = byte * BYTEWORD_LENGTH;
	return BYTEWORDS[w] + BYTEWORDS[w + BYTEWORD_LENGTH - 1];
}

// Reverse map: two-letter minimal code -> byte value, built once.
const CODE_TO_BYTE = /* @__PURE__ */ (() => {
	const m = new Map<string, number>();
	for (let b = 0; b < 256; b++) m.set(minimalCode(b), b);
	return m;
})();

function bytewordsEncodeRaw(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += minimalCode(bytes[i]);
	return out;
}

/** Encode bytes as minimal bytewords with the appended 4-byte CRC-32 checksum. */
function bytewordsEncode(bytes: Uint8Array): string {
	return bytewordsEncodeRaw(bytes) + bytewordsEncodeRaw(u32be(crc32(bytes)));
}

/** Decode a minimal-bytewords string, verifying and stripping its CRC-32. */
function bytewordsDecode(text: string): Uint8Array {
	const clean = text.trim().toLowerCase();
	if (clean.length % 2 !== 0 || clean.length < 8) {
		throw new Error('Malformed bytewords in the QR frame.');
	}
	const total = clean.length / 2;
	const out = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		const b = CODE_TO_BYTE.get(clean.slice(i * 2, i * 2 + 2));
		if (b === undefined) throw new Error('Invalid bytewords in the QR frame.');
		out[i] = b;
	}
	const payload = out.slice(0, total - 4);
	const gotCrc = ((out[total - 4] << 24) | (out[total - 3] << 16) | (out[total - 2] << 8) | out[total - 1]) >>> 0;
	if (gotCrc !== crc32(payload)) {
		throw new Error('QR frame checksum mismatch -- rescan.');
	}
	return payload;
}

// ---- Minimal CBOR -----------------------------------------------------------
// crypto-psbt is JUST a CBOR byte string (major type 2) holding the raw PSBT
// (BCR-2020-004). A multipart part is a CBOR array(5) of
// [seqNum, seqLen, messageLen, checksum, fragment(bytes)]. Hand-encode/decode
// exactly these two shapes rather than pull a CBOR library.

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function cborByteString(bytes: Uint8Array): Uint8Array {
	const len = bytes.length;
	let header: Uint8Array;
	if (len < 24) header = new Uint8Array([0x40 | len]);
	else if (len < 0x100) header = new Uint8Array([0x58, len]);
	else if (len < 0x10000) header = new Uint8Array([0x59, (len >> 8) & 0xff, len & 0xff]);
	else header = new Uint8Array([0x5a, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
	return concat(header, bytes);
}

function cborUint(n: number): Uint8Array {
	if (n < 24) return new Uint8Array([n]);
	if (n < 0x100) return new Uint8Array([0x18, n]);
	if (n < 0x10000) return new Uint8Array([0x19, (n >> 8) & 0xff, n & 0xff]);
	return new Uint8Array([0x1a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** Read a CBOR unsigned integer at `off`. */
function readUint(cbor: Uint8Array, off: number): { value: number; next: number } {
	const b = cbor[off];
	if (b >> 5 !== 0) throw new Error('Expected a CBOR unsigned integer in the QR frame.');
	const info = b & 0x1f;
	if (info < 24) return { value: info, next: off + 1 };
	if (info === 24) return { value: cbor[off + 1], next: off + 2 };
	if (info === 25) return { value: (cbor[off + 1] << 8) | cbor[off + 2], next: off + 3 };
	if (info === 26) {
		return {
			value: ((cbor[off + 1] << 24) | (cbor[off + 2] << 16) | (cbor[off + 3] << 8) | cbor[off + 4]) >>> 0,
			next: off + 5
		};
	}
	throw new Error('Unsupported CBOR integer width in the QR frame.');
}

/** Read a CBOR byte string at `off`, returning its bytes and the next offset. */
function readByteString(cbor: Uint8Array, off: number): { bytes: Uint8Array; next: number } {
	const b = cbor[off];
	if (b >> 5 !== 2) throw new Error('Expected a CBOR byte string in the QR frame.');
	const info = b & 0x1f;
	let len: number;
	let start: number;
	if (info < 24) {
		len = info;
		start = off + 1;
	} else if (info === 24) {
		len = cbor[off + 1];
		start = off + 2;
	} else if (info === 25) {
		len = (cbor[off + 1] << 8) | cbor[off + 2];
		start = off + 3;
	} else if (info === 26) {
		len = ((cbor[off + 1] << 24) | (cbor[off + 2] << 16) | (cbor[off + 3] << 8) | cbor[off + 4]) >>> 0;
		start = off + 5;
	} else {
		throw new Error('Unsupported CBOR byte-string length in the QR frame.');
	}
	if (start + len > cbor.length) throw new Error('CBOR byte string overruns the QR frame.');
	return { bytes: cbor.slice(start, start + len), next: start + len };
}

/** Unwrap a lone crypto-psbt CBOR byte string to the raw PSBT bytes. */
function cborUnwrapPsbt(cbor: Uint8Array): Uint8Array {
	const { bytes, next } = readByteString(cbor, 0);
	if (next !== cbor.length) throw new Error('crypto-psbt CBOR length does not match payload.');
	return bytes;
}

// ---- Multipart fragmentation (BCR-2020-005) --------------------------------
// Fragment-length selection matches the reference's `findNominalFragmentLength`
// (@ngraveio/bc-ur): the smallest fragment count whose equal-sized fragments
// are all <= maxFragmentLength, with a minFragmentLength floor.
function findNominalFragmentLength(messageLength: number, minFragmentLength: number, maxFragmentLength: number): number {
	const maxFragmentCount = Math.ceil(messageLength / minFragmentLength);
	let fragmentLength = 0;
	for (let fragmentCount = 1; fragmentCount <= maxFragmentCount; fragmentCount++) {
		fragmentLength = Math.ceil(messageLength / fragmentCount);
		if (fragmentLength <= maxFragmentLength) break;
	}
	return fragmentLength;
}

/** CBOR-encode one multipart part: array(5) of the five fields. */
function encodePart(seqNum: number, seqLen: number, messageLen: number, checksum: number, fragment: Uint8Array): Uint8Array {
	return concat(
		new Uint8Array([0x85]), // CBOR array, 5 items
		cborUint(seqNum),
		cborUint(seqLen),
		cborUint(messageLen),
		cborUint(checksum),
		cborByteString(fragment)
	);
}

interface ParsedPart {
	seqNum: number;
	seqLen: number;
	messageLen: number;
	checksum: number;
	fragment: Uint8Array;
}

function decodePart(cbor: Uint8Array): ParsedPart {
	if (cbor[0] !== 0x85) throw new Error('QR frame is not a BC-UR multipart array.');
	let off = 1;
	const a = readUint(cbor, off);
	off = a.next;
	const b = readUint(cbor, off);
	off = b.next;
	const c = readUint(cbor, off);
	off = c.next;
	const d = readUint(cbor, off);
	off = d.next;
	const frag = readByteString(cbor, off);
	return { seqNum: a.value, seqLen: b.value, messageLen: c.value, checksum: d.value, fragment: frag.bytes };
}

// ---- Public API (mirrors hw/bbqr.ts) ---------------------------------------

// Default max fragment size (bytes of CBOR message) per QR frame, and the
// floor the reference uses. Kept modest so each frame stays a low-density QR
// a phone camera reads reliably -- the same spirit as bbqr's version cap.
const DEFAULT_MAX_FRAGMENT_LEN = 200;
const MIN_FRAGMENT_LEN = 10;

export interface EncodeOptions {
	/** Cap on CBOR bytes per frame (lower = more, smaller frames). Also lets
	 *  the round-trip test force a multi-frame split. */
	maxFragmentLen?: number;
	/** Floor on the frame count -- forces a multi-frame split even for a tiny
	 *  PSBT (used by the reassembly test). */
	minFragments?: number;
}

/**
 * Encode a base64 PSBT as an array of `ur:crypto-psbt/...` frame strings,
 * ready to render one QR per frame and cycle through on a timer. Mirrors
 * bbqr.ts's `encodePsbtToFrames` signature/shape so `SignWithQr.svelte` can
 * swap codecs by import alone.
 *
 * A PSBT whose CBOR message fits one frame returns a single
 * `ur:crypto-psbt/<bytewords>` frame. A larger one returns the pure multipart
 * sequence `ur:crypto-psbt/<seqNum>-<seqLen>/<part>` (seqNum 1..seqLen). This
 * emits ONLY the pure fragments -- the minimal spec-valid set every BC-UR
 * reader (Jade/Keystone included) needs to reconstruct the message -- never
 * mixed fountain parts (SIGNING.md §1.7).
 */
export function encodePsbtToFrames(psbtBase64: string, opts: EncodeOptions = {}): string[] {
	const psbtBytes = base64.decode(psbtBase64.trim());
	const message = cborByteString(psbtBytes);
	const messageLen = message.length;

	let maxFragmentLen = opts.maxFragmentLen ?? DEFAULT_MAX_FRAGMENT_LEN;
	// Honor minFragments by shrinking the per-frame cap until enough frames result.
	if (opts.minFragments && opts.minFragments > 1) {
		maxFragmentLen = Math.max(1, Math.min(maxFragmentLen, Math.ceil(messageLen / opts.minFragments)));
	}

	const forceMulti = Boolean(opts.minFragments && opts.minFragments > 1);
	// Single-part fast path: the whole CBOR message fits in one frame.
	if (messageLen <= maxFragmentLen && !forceMulti) {
		return [UR_HEADER + bytewordsEncode(message)];
	}

	const fragLen = findNominalFragmentLength(messageLen, Math.min(MIN_FRAGMENT_LEN, maxFragmentLen), maxFragmentLen);
	const seqLen = Math.ceil(messageLen / fragLen);
	const checksum = crc32(message);

	// Pad up to seqLen*fragLen with zeros so every fragment is equal length
	// (the spec pads the final fragment).
	const padded = new Uint8Array(seqLen * fragLen);
	padded.set(message, 0);

	const frames: string[] = [];
	for (let seqNum = 1; seqNum <= seqLen; seqNum++) {
		const start = (seqNum - 1) * fragLen;
		const fragment = padded.slice(start, start + fragLen);
		const part = encodePart(seqNum, seqLen, messageLen, checksum, fragment);
		frames.push(`${UR_HEADER}${seqNum}-${seqLen}/${bytewordsEncode(part)}`);
	}
	return frames;
}

interface ParsedUrFrame {
	seqNum: number | null;
	seqLen: number | null;
	body: string;
}

/** Parse the `ur:crypto-psbt/...` envelope: the sequence info (null when
 *  single-part) and the bytewords body -- or null if the string isn't a
 *  crypto-psbt UR at all (e.g. a BBQr frame, or a stray QR in view). */
function parseUrFrame(frame: string): ParsedUrFrame | null {
	const s = String(frame ?? '').trim().toLowerCase();
	if (!s.startsWith(UR_HEADER)) return null;
	const rest = s.slice(UR_HEADER.length);
	if (rest.length === 0) return null;
	const slash = rest.indexOf('/');
	if (slash === -1) {
		// Single-part: "ur:crypto-psbt/<bytewords>".
		return { seqNum: null, seqLen: null, body: rest };
	}
	// Multipart: "ur:crypto-psbt/<seqNum>-<seqLen>/<bytewords>".
	const m = /^(\d+)-(\d+)$/.exec(rest.slice(0, slash));
	if (!m) return null;
	const body = rest.slice(slash + 1);
	if (body.length === 0) return null;
	return { seqNum: Number(m[1]), seqLen: Number(m[2]), body };
}

/** Cheap per-frame shape check for the QR-codec auto-detect in
 *  `SignWithQr.svelte` -- distinguishes a BC-UR frame from a BBQr one before
 *  either joiner has to throw to find out. */
export function looksLikeUrFrame(s: string): boolean {
	return parseUrFrame(s) !== null;
}

/**
 * Incremental reassembler for BC-UR crypto-psbt frames scanned back from a
 * Jade or Keystone. Mirrors bbqr.ts's `PsbtQrJoiner`: frames arrive from a
 * live camera in no guaranteed order and are re-read many times before the
 * device's display advances, so `add` tolerates duplicates and out-of-order
 * delivery and reports progress after each accepted frame.
 *
 * It collects the PURE fragments (parts whose seqNum <= seqLen -- the single,
 * unmixed fragment each carries). A BC-UR fountain encoder always cycles
 * through those pure fragments before (and interleaved with) any mixed parts,
 * so collecting the pure set always completes the message. Mixed fountain
 * parts (seqNum > seqLen), which would need the spec's Xoshiro+alias fragment
 * chooser to reduce, are deliberately IGNORED here rather than decoded
 * approximately -- the pure set is guaranteed sufficient, and this keeps the
 * module dependency-free and its behavior exactly verifiable. This module's
 * own encoder only ever emits pure parts.
 */
export class PsbtQrJoiner {
	private singleMessage: Uint8Array | null = null;
	private seqLen: number | null = null;
	private messageLen: number | null = null;
	private checksum: number | null = null;
	private fragmentLen: number | null = null;
	private fragments = new Map<number, Uint8Array>();

	/** Feed one decoded QR string. Returns whether the message is complete and
	 *  how many distinct pure fragments are recovered so far. Throws on a
	 *  string that isn't a crypto-psbt UR frame at all so the caller can say
	 *  "that's not a signed-transaction QR" rather than silently ignoring it. */
	add(frame: string): { complete: boolean; progress: { have: number; total: number } } {
		const parsed = parseUrFrame(frame);
		if (!parsed) throw new Error("That QR code isn't a signed-transaction frame.");

		// Single-part UR: the whole CBOR message, bytewords + CRC.
		if (parsed.seqNum === null || parsed.seqLen === null) {
			this.singleMessage = bytewordsDecode(parsed.body);
			this.seqLen = 1;
			return { complete: true, progress: { have: 1, total: 1 } };
		}

		const part = decodePart(bytewordsDecode(parsed.body));
		// First multipart frame fixes the sequence parameters; later frames must agree.
		if (this.seqLen === null) {
			this.seqLen = part.seqLen;
			this.messageLen = part.messageLen;
			this.checksum = part.checksum;
			this.fragmentLen = part.fragment.length;
		} else if (this.seqLen !== part.seqLen || this.messageLen !== part.messageLen || this.checksum !== part.checksum) {
			throw new Error('These QR frames belong to two different transactions -- rescan just one.');
		}

		// Pure fragment (seqNum in 1..seqLen) -> store at its 0-based index.
		// Mixed fountain parts (seqNum > seqLen) are ignored (see the class doc).
		if (part.seqNum >= 1 && part.seqNum <= part.seqLen) {
			this.fragments.set(part.seqNum - 1, part.fragment);
		}

		return { complete: this.isComplete(), progress: this.progress() };
	}

	isComplete(): boolean {
		if (this.singleMessage !== null) return true;
		return this.seqLen !== null && this.fragments.size === this.seqLen;
	}

	missing(): number[] {
		if (this.singleMessage !== null || this.seqLen === null) return [];
		const out: number[] = [];
		for (let i = 0; i < this.seqLen; i++) if (!this.fragments.has(i)) out.push(i);
		return out;
	}

	progress(): { have: number; total: number } {
		if (this.singleMessage !== null) return { have: 1, total: 1 };
		return { have: this.fragments.size, total: this.seqLen ?? 0 };
	}

	reset(): void {
		this.singleMessage = null;
		this.seqLen = null;
		this.messageLen = null;
		this.checksum = null;
		this.fragmentLen = null;
		this.fragments.clear();
	}

	/** Reassemble the completed sequence back into a base64 PSBT. Throws if
	 *  the sequence is incomplete or the assembled message fails its
	 *  CRC/CBOR unwrap. */
	result(): string {
		let message: Uint8Array;
		if (this.singleMessage !== null) {
			message = this.singleMessage;
		} else {
			if (!this.isComplete()) {
				const miss = this.missing().length;
				throw new Error(`Still scanning -- ${miss} of ${this.seqLen} frame(s) left.`);
			}
			const fragLen = this.fragmentLen ?? 0;
			const joined = new Uint8Array((this.seqLen ?? 0) * fragLen);
			for (let i = 0; i < (this.seqLen ?? 0); i++) {
				const f = this.fragments.get(i);
				if (f === undefined) throw new Error(`Missing BC-UR fragment ${i}.`);
				joined.set(f, i * fragLen);
			}
			// Trim the zero padding back to the declared message length.
			message = joined.slice(0, this.messageLen ?? joined.length);
			if (this.checksum !== null && crc32(message) !== this.checksum) {
				throw new Error('Reassembled transaction failed its checksum -- rescan.');
			}
		}
		return base64.encode(cborUnwrapPsbt(message));
	}
}

// ---- Test-only helpers ------------------------------------------------------
// Exported solely so jadeUr.spec.ts can construct a synthetic MIXED fountain
// part (seqNum > seqLen, encoded into the actual CBOR body -- the wire format
// carries seqNum/seqLen authoritatively inside the bytewords-encoded part,
// not just in the human-readable `<n>-<m>` URL segment) to verify
// PsbtQrJoiner's documented ignore-it behavior (SIGNING.md §5.3) without
// needing a full Xoshiro+alias fountain implementation this module
// deliberately doesn't own.
export const __test = { encodePart, decodePart, bytewordsEncode, bytewordsDecode, findNominalFragmentLength };
