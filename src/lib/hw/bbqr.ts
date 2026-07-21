/**
 * Animated-QR PSBT codec (SIGNING.md §1.6) -- BBQr, for air-gap camera
 * signers (SeedSigner, Foundation Passport, Coldcard-Q, Jade-BBQr-mode).
 * Pure, DOM-free wrapper over the `bbqr` npm package (`splitQRs`/`joinQRs`)
 * plus base64<->bytes conversion. BROWSER-SIDE ONLY.
 */
import { base64 } from '@scure/base';
import { splitQRs, joinQRs, type Version } from 'bbqr';

/** BBQr registry letter for a PSBT payload. */
const PSBT_FILETYPE = 'P';

export interface EncodeOptions {
	minSplit?: number;
	maxSplit?: number;
	maxVersion?: number;
}

/** Split a PSBT (base64) into animated-QR frame strings. Uses plain base32
 *  encoding ('2'), NOT the package default zlib ('Z') -- base32 is
 *  self-describing per-frame, so every frame is independently decodable
 *  rather than depending on cross-frame compression state. When the caller
 *  asks for more than one frame (`minSplit > 1`), the per-frame QR *version*
 *  (density) must also be capped, or the package won't split below its
 *  default `minVersion` floor. */
export function encodePsbtToFrames(psbtBase64: string, opts: EncodeOptions = {}): string[] {
	return encodePsbtToFramesDetailed(psbtBase64, opts).parts;
}

/** Same as `encodePsbtToFrames`, but also returns the QR `version` (module
 *  density) `splitQRs` picked -- needed by `renderQRImage` (SignWithQr.svelte's
 *  animated-display half) to render frames at a consistent density. */
export function encodePsbtToFramesDetailed(
	psbtBase64: string,
	opts: EncodeOptions = {}
): { parts: string[]; version: Version } {
	const bytes = base64.decode(psbtBase64.trim());
	const minSplit = opts.minSplit ?? 1;
	const maxVersionCap = opts.maxVersion ?? (minSplit > 1 ? 5 : undefined);
	const { parts, version } = splitQRs(bytes, PSBT_FILETYPE, {
		encoding: '2',
		minSplit,
		maxSplit: opts.maxSplit ?? 1295,
		...(maxVersionCap !== undefined
			? { minVersion: 1 as const, maxVersion: maxVersionCap as never }
			: {})
	});
	return { parts, version };
}

/** Cheap per-frame header parse for progress tracking -- NOT a full decode
 *  (that's `joinQRs`'s job at reassemble time). `B$` + encoding(1) +
 *  fileType(1) + total(base36,2) + index(base36,2). */
const BBQR_HEADER_RE = /^B\$([A-Z0-9])([A-Z0-9])([0-9A-Z]{2})([0-9A-Z]{2})/;

interface BbqrHeader {
	encoding: string;
	fileType: string;
	total: number;
	index: number;
}

function parseBbqrHeader(frame: string): BbqrHeader | null {
	const m = BBQR_HEADER_RE.exec(frame.trim());
	if (!m) return null;
	const total = parseInt(m[3], 36);
	const index = parseInt(m[4], 36);
	if (!Number.isInteger(total) || !Number.isInteger(index) || index >= total || total <= 0) return null;
	return { encoding: m[1], fileType: m[2], total, index };
}

/** Incremental BBQr reassembler for the camera scan-back flow. De-dupes
 *  repeat scans of the same frame, tolerates out-of-order arrival, and
 *  rejects mixed-sequence / non-BBQr frames loudly rather than silently
 *  ignoring them (so the UI can say "that's not a signed-transaction QR"). */
export class PsbtQrJoiner {
	private frames = new Map<number, string>();
	private total: number | null = null;

	/** Feed one decoded QR frame's raw text. */
	add(frame: string): { complete: boolean; progress: { have: number; total: number } } {
		const parsed = parseBbqrHeader(frame);
		if (!parsed) throw new Error("That QR code isn't a signed-transaction frame.");
		if (this.total === null) {
			this.total = parsed.total;
		} else if (this.total !== parsed.total) {
			throw new Error('These QR frames belong to two different transactions -- rescan just one.');
		}
		this.frames.set(parsed.index, frame.trim());
		return { complete: this.isComplete(), progress: { have: this.frames.size, total: this.total } };
	}

	isComplete(): boolean {
		return this.total !== null && this.frames.size === this.total;
	}

	missing(): number[] {
		if (this.total === null) return [];
		const out: number[] = [];
		for (let i = 0; i < this.total; i++) if (!this.frames.has(i)) out.push(i);
		return out;
	}

	progress(): { have: number; total: number } {
		return { have: this.frames.size, total: this.total ?? 0 };
	}

	reset(): void {
		this.frames.clear();
		this.total = null;
	}

	/** Reassemble the completed sequence back into a base64 PSBT. */
	result(): string {
		if (!this.isComplete()) {
			const miss = this.missing();
			throw new Error(`Still scanning -- ${miss.length} of ${this.total} frame(s) left.`);
		}
		const ordered: string[] = [];
		for (let i = 0; i < (this.total as number); i++) ordered.push(this.frames.get(i) as string);
		const { raw } = joinQRs(ordered);
		return base64.encode(raw);
	}
}
