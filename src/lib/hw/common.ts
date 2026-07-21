/**
 * Shared browser-side signing-surface plumbing (SIGNING.md §0.3). BROWSER-SIDE
 * ONLY -- imports nothing from `$lib/server` (enforced by boundary.spec.ts).
 * Only `@scure/*` / `@noble/*` deps -- no vendor hardware libraries here (those
 * are lazy-imported inside ledger.ts / trezor.ts so non-users never load them).
 *
 * Ported as a PATTERN from `C:\dev\cairn\src\lib\hw\common.ts` (never copied):
 * the typed-error base, SLIP-132 xpub version rewriting, and BIP32 path
 * parse/format helpers that every driver in this directory needs.
 */
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

/** Typed-error base every driver subclasses with its own error-code union
 *  (e.g. `LedgerError extends HwError<LedgerErrorCode>`), passing its own
 *  class name so `err.name` reads correctly and `err.code` is switchable. */
export class HwError<Code extends string = string> extends Error {
	readonly code: Code;
	constructor(name: string, message: string, code: Code, options?: { cause?: unknown }) {
		super(message);
		this.name = name;
		this.code = code;
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

export const HARDENED = 0x80000000;

/** Standard mainnet xpub version bytes (SLIP-132 "no prefix" form). */
export const XPUB_VERSION = 0x0488b21e;

/** SLIP-132 alternate version prefixes that must be rewritten back to XPUB_VERSION
 *  before any BIP32 derivation -- devices and @scure/bip32 both expect the
 *  plain xpub prefix regardless of what a wallet exported. */
const SLIP132_VERSIONS: ReadonlySet<number> = new Set([
	0x049d7cb2, // ypub (p2sh-p2wpkh)
	0x04b24746, // zpub (p2wpkh)
	0x0295b43f, // Ypub (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub (p2wsh multisig)
]);

const b58check = createBase58check(sha256);

/** Rewrite a base58check-encoded extended key's 4-byte version prefix. Passes
 *  non-decodable / wrong-length input through unchanged so a later real parse
 *  surfaces the actual error rather than this helper masking it. */
export function xpubWithVersion(input: string, version: number): string {
	let bytes: Uint8Array;
	try {
		bytes = b58check.decode(input);
	} catch {
		return input;
	}
	if (bytes.length !== 78) return input;
	const out = new Uint8Array(bytes);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint32(0, version >>> 0, false);
	return b58check.encode(out);
}

/** Normalize any SLIP-132 xpub variant (ypub/zpub/Ypub/Zpub) to the plain
 *  xpub prefix. Passthrough for anything that doesn't decode or isn't a
 *  known SLIP-132 version (including an already-plain xpub). */
export function normalizeXpub(input: string): string {
	let bytes: Uint8Array;
	try {
		bytes = b58check.decode(input);
	} catch {
		return input;
	}
	if (bytes.length !== 78) return input;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint32(0, false);
	if (!SLIP132_VERSIONS.has(version)) return input;
	return xpubWithVersion(input, XPUB_VERSION);
}

/** Parse a BIP32 path string ("m/84'/0'/0'", tolerating h/H/' hardened
 *  markers and an optional leading "m/") into raw index numbers. Throws via
 *  the caller-supplied `fail` factory so each driver raises its own typed
 *  error (LedgerError, TrezorError, ...) rather than a bare Error. */
export function parseKeyPath(path: string, label: string, fail: (message: string) => Error): number[] {
	let p = path.trim();
	if (/^m\/?/i.test(p)) p = p.replace(/^m\/?/i, '');
	if (p === '') return [];
	const segments = p.split('/');
	const out: number[] = [];
	for (const seg of segments) {
		const m = /^(\d+)(['hH])?$/.exec(seg);
		if (!m) throw fail(`${label}: "${path}" is not a valid derivation path`);
		const index = parseInt(m[1], 10);
		if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
			throw fail(`${label}: "${path}" has an out-of-range index`);
		}
		out.push(m[2] ? index + HARDENED : index);
	}
	return out;
}

/** Format raw BIP32 indexes back into "m/84'/0'/0'" form (hardened-only
 *  paths, which is all this signing surface ever emits/consumes). */
export function formatKeyPath(indexes: number[]): string {
	if (indexes.length === 0) return 'm';
	return (
		'm/' +
		indexes
			.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`))
			.join('/')
	);
}

/** A cosigner key as the wallet-engine's `CosignerKey` shape reaches the
 *  browser (SIGNING.md §1's "MultisigSignKey"): SLIP-132/plain xpub as the
 *  user/import supplied it, 8-hex fingerprint ("00000000" = unknown), and
 *  the key-origin path ("m" = unknown). */
export interface MultisigSignKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

/** Bound how long the UI waits on a single device round-trip (SIGNING.md §1:
 *  no transport -- WebHID / Connect -- exposes a cancellation hook, so a
 *  hung/locked/unplugged device otherwise traps the caller forever). This
 *  cannot actually cancel the underlying call; it only bounds how long the
 *  caller waits, surfacing a typed timeout the UI can offer "Try again" on.
 *  `onTimeout` builds the driver's own typed error (so a Ledger timeout is a
 *  LedgerError, a Trezor timeout a TrezorError, etc). */
export function withDeviceTimeout<T>(
	promise: Promise<T>,
	label: string,
	onTimeout: (label: string) => Error,
	ms = 45_000
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout(label)), ms);
		// Node/Vitest fake-timer friendliness; browsers ignore unref().
		(timer as unknown as { unref?: () => void }).unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}
