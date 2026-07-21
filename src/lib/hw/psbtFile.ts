/**
 * Sign-with-file (SIGNING.md §1.5) -- the universal air-gap fallback. No
 * library, no secure context, works in every browser. Downloads the unsigned
 * PSBT as a `.psbt` file; reads a signed `.psbt` upload back, normalizing
 * binary-or-base64-armored input to base64 for the `/sign` POST body.
 * BROWSER-SIDE ONLY.
 */
import { base64 } from '@scure/base';

/** A PSBT file's magic bytes (`psbt\xff`), used to detect a raw-binary upload
 *  vs. a base64/base64-armored text upload. */
const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]);

function looksLikePsbtMagic(bytes: Uint8Array): boolean {
	if (bytes.length < PSBT_MAGIC.length) return false;
	for (let i = 0; i < PSBT_MAGIC.length; i++) {
		if (bytes[i] !== PSBT_MAGIC[i]) return false;
	}
	return true;
}

/** Typed error for an upload that is neither raw-binary PSBT bytes nor a
 *  base64/base64-armored PSBT string. */
export class InvalidPsbtFileError extends Error {
	constructor(message = "That file doesn't look like a PSBT.") {
		super(message);
		this.name = 'InvalidPsbtFileError';
	}
}

/** Build the download filename for an unsigned draft (SIGNING.md §1.5). */
export function psbtFilename(walletId: number, draftId: number): string {
	return `wallet-${walletId}-draft-${draftId}.psbt`;
}

/** Decode the base64 PSBT the server hands the browser into raw bytes for a
 *  download `Blob`. Kept as a tiny pure function so the Svelte component only
 *  has to build the `<a download>`/anchor-click plumbing. */
export function psbtBase64ToBytes(psbtBase64: string): Uint8Array {
	return base64.decode(psbtBase64.trim());
}

/** Read an uploaded signed-PSBT `File`/`Blob` and normalize it to base64,
 *  whatever shape it arrived in:
 *  - raw binary PSBT bytes (the common case -- most signers write `.psbt` as
 *    the raw BIP174 magic + bytes)
 *  - a base64-armored text file (some signers/paste flows)
 *  Throws `InvalidPsbtFileError` for anything that is neither. */
export async function readSignedPsbtUpload(file: Blob): Promise<string> {
	const buf = new Uint8Array(await file.arrayBuffer());
	if (looksLikePsbtMagic(buf)) {
		return base64.encode(buf);
	}
	// Not raw-binary magic -- try decoding as UTF-8 text and treating it as a
	// base64(-armored) string. Strip whitespace/newlines a copy-paste or a
	// wrapped text file might have introduced.
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/\s+/g, '');
	} catch {
		throw new InvalidPsbtFileError();
	}
	if (text.length === 0) throw new InvalidPsbtFileError();
	let decoded: Uint8Array;
	try {
		decoded = base64.decode(text);
	} catch {
		throw new InvalidPsbtFileError();
	}
	if (!looksLikePsbtMagic(decoded)) throw new InvalidPsbtFileError();
	return base64.encode(decoded);
}
