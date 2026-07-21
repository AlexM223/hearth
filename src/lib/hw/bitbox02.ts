/**
 * BitBox02 signing driver (SIGNING.md §1.3) -- `bitbox-api` (Rust->WASM) over
 * WebHID, falling back to the BitBoxBridge native service when WebHID is
 * absent (Firefox/Safari, or any browser on a plain-HTTP origin like Umbrel's
 * `:3252`). Stage 2. BROWSER-SIDE ONLY -- imports nothing from `$lib/server`
 * (enforced by boundary.spec.ts). The heavy WASM module is lazy-imported
 * inside the functions that need it (`await import('bitbox-api')`) so SSR and
 * non-BitBox users never pay to load it, and WebHID globals are only touched
 * after a click.
 *
 * Ported as a PATTERN from `C:\dev\cairn\src\lib\hw\bitbox02.ts` (never
 * copied): `connectAndPair`'s Noise trust-on-first-use pairing-code callback,
 * the multisig script-config registration idempotency check
 * (`maybeRegisterMultisig`, fixing cairn-5kth/audit F6 -- signing without
 * registration), and the typed error map. Two things are deliberately NOT
 * ported from cairn, to match Hearth's Ledger/Trezor calling convention
 * (SIGNING.md's "same driver interface" rule -- no parallel path):
 *
 * 1. Cairn's UI supplies `ourXpubIndex`/`expectedKey` -- the caller already
 *    knows which cosigner slot it's signing. Hearth's Ledger/Trezor drivers
 *    instead read the connected device's own identity and find its slot in
 *    the roster themselves (`selectMultisigKeyForDevice` in trezor.ts,
 *    `assertDeviceIsMultisigCosigner` in ledger.ts) -- so does this driver
 *    (`findDeviceKeyIndex`), keeping the cosigner-roster UX identical across
 *    all three device families: plug in, and Hearth figures out who you are.
 * 2. No import-wizard "read a key from the device" functions -- Hearth
 *    imports wallets by descriptor/xpub, never by reading a fresh key off a
 *    device (matching ledger.ts/trezor.ts, neither of which has one either).
 *
 * Unlike Ledger/Trezor (which return per-input signatures this driver code
 * merges back itself), the BitBox02 signs the whole PSBT and hands back the
 * fully-signed PSBT as base64 directly (`btcSignPSBT`) -- there is no
 * merge-back step here. The returned PSBT still commits to the exact
 * inputs/outputs the user reviewed; the server re-checks that commitment
 * (`assertSameTransaction`) same as every other method (SIGNING.md §0.2).
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HwError, HARDENED, formatKeyPath, normalizeXpub, withDeviceTimeout } from './common.js';
import { isWebHidAvailable } from './secureContext.js';
import type { MultisigSignKey } from './common.js';
export type { MultisigSignKey } from './common.js';

// ---- Types imported for annotations only (erased at build, no runtime load)
// -- bitbox-api ships generated .d.ts types; `import type` never pulls the
// WASM module into the bundle.
import type { PairedBitBox as PairedBitBoxType } from 'bitbox-api';

export type Bitbox02ErrorCode =
	| 'unsupported-browser' // neither WebHID nor the BitBoxBridge could reach a device
	| 'unavailable' // not a browser (SSR/Node) -- navigator/window missing entirely
	| 'device_locked' // device not unlocked (password not entered)
	| 'pairing_rejected' // user declined the on-device pairing confirmation
	| 'rejected' // user declined an operation on-device
	| 'no_device' // no device chosen from the browser picker / disconnected
	| 'unsupported_script_type' // p2pkh single-sig or plain-p2sh multisig -- no device config exists
	| 'bad_psbt' // PSBT the device could not sign / driver could not parse
	| 'wrong_device' // the connected BitBox02 holds none of this wallet's keys
	| 'timeout' // the device did not respond within DEVICE_TIMEOUT_MS
	| 'unexpected';

export class Bitbox02Error extends HwError<Bitbox02ErrorCode> {
	constructor(message: string, code: Bitbox02ErrorCode, options?: { cause?: unknown }) {
		super('Bitbox02Error', message, code, options);
	}
}

const DEVICE_TIMEOUT_MS = 45_000;

function timeoutError(label: string): Bitbox02Error {
	return new Bitbox02Error(
		`Your BitBox02 didn't respond while ${label}. Make sure it's unlocked and try again.`,
		'timeout'
	);
}

function withBitbox02Timeout<T>(p: Promise<T>, label: string): Promise<T> {
	return withDeviceTimeout(p, label, timeoutError, DEVICE_TIMEOUT_MS);
}

/** True in any browser (`window` present) -- WebHID connects directly; without
 *  it (Firefox/Safari, or a plain-HTTP origin like Umbrel's `:3252`) the
 *  locally-installed BitBoxBridge service can still reach the device. Only
 *  SSR/Node is a hard no -- probes `window`, not `navigator` (Node 21+ also
 *  defines `navigator` globally, which would otherwise misreport this true). */
export function isBitbox02Available(): boolean {
	return typeof window !== 'undefined';
}

// ==================== Single-sig ====================
//
// The BitBox02's single-sig ("simple") script configs are p2wpkhP2sh (BIP-49)
// and p2wpkh (BIP-84). There is deliberately no p2pkh (BIP-44) simple type in
// the firmware -- legacy single-sig is unsupported on the device. (Hearth's
// own SingleScriptType has no p2tr yet either, so that BitBox02-supported
// case isn't reachable from this codebase's wallet types today.)

export type SingleScriptTypeForBitbox02 = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
export type BitboxSimpleType = 'p2wpkhP2sh' | 'p2wpkh';

const SIMPLE_TYPE: Record<SingleScriptTypeForBitbox02, BitboxSimpleType | null> = {
	p2pkh: null, // BIP-44 legacy -- the firmware has no simple type for it
	'p2sh-p2wpkh': 'p2wpkhP2sh', // BIP-49
	p2wpkh: 'p2wpkh' // BIP-84
};

const PURPOSE_FOR_SIMPLE_TYPE: Record<SingleScriptTypeForBitbox02, number | null> = {
	p2pkh: null,
	'p2sh-p2wpkh': 49,
	p2wpkh: 84
};

/** Purpose (the account path's first hardened element) -> device simpleType,
 *  used to derive the script config straight from a PSBT's own
 *  `bip32Derivation` (never asked of the caller), mirroring
 *  `ledger.ts`'s `accountOriginFromPsbt`. */
const PURPOSE_SIMPLE_TYPE: Record<number, BitboxSimpleType> = { 49: 'p2wpkhP2sh', 84: 'p2wpkh' };

/** Whether the BitBox02 can act as a single-sig signer for a script type.
 *  False for p2pkh (BIP-44), which the firmware has no simple config for --
 *  exported so the method picker can grey out the tile with a reason instead
 *  of failing mid-flow (SIGNING.md §1.3). */
export function bitbox02SupportsScriptType(scriptType: SingleScriptTypeForBitbox02): boolean {
	return SIMPLE_TYPE[scriptType] != null;
}

/** The standard single-sig account keypath for a script type:
 *  `m/49'/0'/{account}'` (p2sh-p2wpkh) or `m/84'/0'/{account}'` (p2wpkh).
 *  Mainnet only (coin 0'), matching the rest of Hearth. Exported for unit
 *  testing -- load-bearing pure logic. */
export function singleSigAccountPath(scriptType: SingleScriptTypeForBitbox02, account = 0): string {
	const purpose = PURPOSE_FOR_SIMPLE_TYPE[scriptType];
	if (purpose == null) {
		throw new Bitbox02Error(
			'The BitBox02 does not support legacy (P2PKH) single-sig accounts. Choose a SegWit address type.',
			'unsupported_script_type'
		);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw new Bitbox02Error(`Invalid account index ${account}.`, 'unexpected');
	}
	return `m/${purpose}'/0'/${account}'`;
}

/** Build the single-sig script config for a script type. Throws for p2pkh. */
export function buildSimpleScriptConfig(scriptType: SingleScriptTypeForBitbox02): { simpleType: BitboxSimpleType } {
	const simpleType = SIMPLE_TYPE[scriptType];
	if (simpleType == null) {
		throw new Bitbox02Error('The BitBox02 does not support this single-sig address type.', 'unsupported_script_type');
	}
	return { simpleType };
}

/** Derive the account origin (fingerprint, path, device simpleType) straight
 *  from the PSBT's OWN `bip32Derivation` -- never hardcoded, mirroring
 *  `ledger.ts`'s `accountOriginFromPsbt`. Fails fast, before touching any
 *  device, on a PSBT that doesn't carry key-origin metadata or uses a script
 *  type the firmware has no simple config for. */
export function accountOriginFromPsbtForBitbox02(unsignedPsbtBase64: string): {
	fingerprint: number;
	accountPath: number[];
	simpleType: BitboxSimpleType;
} {
	let tx: btc.Transaction;
	try {
		tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch {
		throw new Bitbox02Error('That draft is not a valid transaction to sign.', 'bad_psbt');
	}
	if (tx.inputsLength === 0) throw new Bitbox02Error('That draft has no inputs to sign.', 'bad_psbt');
	const input = tx.getInput(0);
	const derivations = input.bip32Derivation;
	if (!derivations || derivations.length === 0) {
		throw new Bitbox02Error("That draft doesn't carry the key information a device needs to sign.", 'bad_psbt');
	}
	const [, meta] = derivations[0];
	const fullPath = meta.path;
	if (fullPath.length < 3) throw new Bitbox02Error('That draft has an unusual derivation path.', 'bad_psbt');
	const accountPath = fullPath.slice(0, -2);
	const purpose = accountPath[0] - HARDENED;
	const simpleType = PURPOSE_SIMPLE_TYPE[purpose];
	if (!simpleType) {
		throw new Bitbox02Error('That draft uses a script type this signer does not support.', 'bad_psbt');
	}
	return { fingerprint: meta.fingerprint, accountPath, simpleType };
}

// ==================== Multisig ====================
//
// BitBox02 multisig uses BtcMultisigScriptType = 'p2wsh' | 'p2wshP2sh' -- the
// device supports native P2WSH and P2SH-wrapped-P2WSH ONLY. Plain legacy
// P2SH multisig is not a device script type (Hearth's own MultisigScriptType
// includes plain 'p2sh' as a wallet-engine option, so this returns false for
// it rather than failing mid-flow).

export type MultisigScriptTypeForBitbox02 = 'p2sh' | 'p2sh-p2wsh' | 'p2wsh';
export type BitboxMultisigScriptType = 'p2wsh' | 'p2wshP2sh';

const MULTISIG_TYPE: Record<MultisigScriptTypeForBitbox02, BitboxMultisigScriptType | null> = {
	p2wsh: 'p2wsh',
	'p2sh-p2wsh': 'p2wshP2sh',
	p2sh: null // legacy P2SH multisig -- no device script type exists for it
};

/** Whether the BitBox02 can act as a multisig signer for a script type. False
 *  ONLY for plain 'p2sh'. Exported so the roster UI can grey out the BitBox02
 *  option for that wallet with copy, rather than a mid-flow failure. */
export function bitbox02SupportsMultisigScriptType(scriptType: MultisigScriptTypeForBitbox02): boolean {
	return MULTISIG_TYPE[scriptType] != null;
}

/** The BIP-48 account keypath for a multisig cosigner key:
 *  `m/48'/0'/{account}'/{2|1}'` (native p2wsh gets suffix 2', wrapped
 *  p2sh-p2wsh gets 1' -- matching Hearth's own `defaultAccountPath` in
 *  `$lib/server/wallet/import.ts`). Exported for unit testing; NOT used by
 *  `signMultisigPsbtWithBitbox02` itself, which uses each cosigner's own
 *  recorded `path` -- kept for parity with the pure-logic surface the other
 *  drivers expose and any future device-side key-read wizard. */
export function multisigAccountPath(scriptType: MultisigScriptTypeForBitbox02, account = 0): string {
	if (!bitbox02SupportsMultisigScriptType(scriptType)) {
		throw new Bitbox02Error(
			'The BitBox02 cannot sign for a legacy (plain P2SH) multisig -- it supports only P2WSH and P2SH-P2WSH multisigs.',
			'unsupported_script_type'
		);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw new Bitbox02Error(`Invalid account index ${account}.`, 'unexpected');
	}
	const sub = scriptType === 'p2wsh' ? 2 : 1;
	return `m/48'/0'/${account}'/${sub}'`;
}

export interface BitboxMultisigScriptConfig {
	multisig: {
		threshold: number;
		xpubs: string[];
		ourXpubIndex: number;
		scriptType: BitboxMultisigScriptType;
	};
}

/** Build the device multisig script config for a wallet's cosigner roster,
 *  given which key is THIS device (`ourXpubIndex`). The device requires
 *  every cosigner xpub in the SAME ORDER for every call and for
 *  registration -- Hearth passes `keys` in its stored roster order, which
 *  must stay stable call-to-call for a given wallet. xpubs are canonicalized
 *  to standard xpub form. Exported for unit testing -- load-bearing pure
 *  logic. */
export function buildMultisigScriptConfig(
	keys: MultisigSignKey[],
	ourXpubIndex: number,
	threshold: number,
	scriptType: MultisigScriptTypeForBitbox02
): BitboxMultisigScriptConfig {
	const deviceScriptType = MULTISIG_TYPE[scriptType];
	if (deviceScriptType == null) {
		throw new Bitbox02Error(
			'The BitBox02 cannot sign for a legacy (plain P2SH) multisig -- it supports only P2WSH and P2SH-P2WSH multisigs.',
			'unsupported_script_type'
		);
	}
	if (!Array.isArray(keys) || keys.length === 0) {
		throw new Bitbox02Error('This wallet has no keys.', 'unexpected');
	}
	if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) {
		throw new Bitbox02Error(`Invalid multisig threshold ${threshold} for ${keys.length} keys.`, 'unexpected');
	}
	if (!Number.isInteger(ourXpubIndex) || ourXpubIndex < 0 || ourXpubIndex >= keys.length) {
		throw new Bitbox02Error(`Invalid device key index ${ourXpubIndex}.`, 'unexpected');
	}
	return {
		multisig: {
			threshold,
			xpubs: keys.map((k) => normalizeXpub(k.xpub)),
			ourXpubIndex,
			scriptType: deviceScriptType
		}
	};
}

/** Does a connected device's identity match the multisig key a signing slot
 *  expects? Primary check: the account xpub read from the device equals the
 *  stored cosigner xpub (compared after SLIP-132 normalization so a version
 *  prefix alone can't cause a false negative). Fallback: the device's root
 *  fingerprint equals the key's recorded (non-placeholder) fingerprint.
 *  Exported for unit testing. */
export function bitboxKeyIdentityMatches(
	expected: { xpub: string; fingerprint: string },
	reading: { xpub: string; fingerprint: string }
): boolean {
	if (normalizeXpub(expected.xpub) === normalizeXpub(reading.xpub)) return true;
	const fp = reading.fingerprint.trim().toLowerCase();
	return fp !== '' && fp !== '00000000' && fp === expected.fingerprint.trim().toLowerCase();
}

/** Which of this wallet's cosigner keys the connected device is, by root
 *  fingerprint (mirrors `selectMultisigKeyForDevice` in trezor.ts /
 *  `assertDeviceIsMultisigCosigner` in ledger.ts -- the device is never
 *  pre-told which slot it is; Hearth finds it from the roster). */
function findDeviceKeyIndex(keys: MultisigSignKey[], deviceFingerprint: string): number {
	const idx = keys.findIndex((k) => k.fingerprint.toLowerCase() === deviceFingerprint.toLowerCase());
	if (idx !== -1) return idx;
	const roster = keys.map((k) => k.fingerprint).join(', ');
	throw new Bitbox02Error(
		`This BitBox02 (fingerprint ${deviceFingerprint}) isn't one of this wallet's cosigners (expects one of: ${roster}).`,
		'wrong_device'
	);
}

// ==================== Error map ====================
//
// bitbox-api raises typed errors; run any caught value through the library's
// own `ensureError()` to get `{ code, message }`. `isUserAbort` is the
// library's own predicate for the on-device cancel case.

interface BitboxApiError {
	code?: string;
	message?: string;
}

/** Translate a raw error into a typed Bitbox02Error. `deps` supplies the
 *  loaded module's `ensureError`/`isUserAbort` so this stays usable inside
 *  the device flow; omit for a plain fallback (still classifies by regex).
 *  Exported for unit testing (pass a stub `deps`). */
export function toBitbox02Error(
	err: unknown,
	deps?: {
		ensureError?: (e: unknown) => BitboxApiError;
		// isUserAbort's param is intentionally loose: bitbox-api's own .d.ts
		// types it against a MODULE-LOCAL `Error = { code, message, err? }` shape
		// (shadowing the global `Error` name inside that file), not the real
		// thrown JS Error this driver actually has in hand -- a stricter
		// signature here would refuse the real module's export at the call
		// site below. Ported verbatim from cairn's bitbox02.ts, which hit this
		// same mismatch.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		isUserAbort?: (e: any) => boolean;
	}
): Bitbox02Error {
	if (err instanceof Bitbox02Error) return err;

	let typed: BitboxApiError | null = null;
	try {
		typed = deps?.ensureError ? deps.ensureError(err) : null;
	} catch {
		typed = null;
	}
	const raw = err as { code?: unknown; message?: unknown; name?: unknown } | null;
	const code = String(typed?.code ?? raw?.code ?? '');
	const msg = String(typed?.message ?? raw?.message ?? err ?? '');

	let aborted = false;
	try {
		if (deps?.isUserAbort && err instanceof Error) aborted = deps.isUserAbort(err);
	} catch {
		aborted = false;
	}
	if (aborted || /user-abort|user_abort|aborted|cancell?ed|declined/i.test(code + ' ' + msg)) {
		return new Bitbox02Error('You cancelled the request on the BitBox02.', 'rejected', { cause: err });
	}
	if (/unpaired|pairing|noise/i.test(code + ' ' + msg)) {
		return new Bitbox02Error(
			'Pairing was not completed. Reconnect and confirm the pairing code on the BitBox02.',
			'pairing_rejected',
			{ cause: err }
		);
	}
	if (/locked|not-initialized|uninitialized|password/i.test(code + ' ' + msg)) {
		return new Bitbox02Error('Unlock your BitBox02 (enter your password), then connect again.', 'device_locked', {
			cause: err
		});
	}
	if (/no device|not.?found|disconnect|NotFoundError|no-device/i.test(code + ' ' + msg) || raw?.name === 'NotFoundError') {
		return new Bitbox02Error(
			'No BitBox02 was selected. Plug it in, unlock it, then pick it from the browser prompt.',
			'no_device',
			{ cause: err }
		);
	}
	return new Bitbox02Error(msg ? `BitBox02 error: ${msg}` : 'The BitBox02 request failed.', 'unexpected', { cause: err });
}

// ==================== Device I/O ====================

type BitboxModule = typeof import('bitbox-api');

/** Lazily import the bitbox-api WASM module. Kept inside the device flow so
 *  nothing WASM-related is evaluated during SSR or for users who never click. */
async function loadBitbox(): Promise<BitboxModule> {
	return import('bitbox-api');
}

/** Connect (WebHID, or the BitBoxBridge when WebHID is absent), unlock, and
 *  pair, returning a PairedBitBox plus a `close()` helper. `onPairingCode` is
 *  invoked with the trust-on-first-use pairing code (first connection only,
 *  per browser -- the WASM persists the pinned key in `localStorage` itself,
 *  no Hearth-side storage) so the UI can display it while the user confirms
 *  on-device; on an already-paired device the code is undefined and the
 *  callback is not invoked. */
async function connectAndPair(
	mod: BitboxModule,
	onPairingCode?: (code: string) => void
): Promise<{ paired: PairedBitBoxType; close: () => void }> {
	if (!isBitbox02Available()) {
		throw new Bitbox02Error('The BitBox02 can only connect from a web browser.', 'unavailable');
	}

	let unpaired: Awaited<ReturnType<BitboxModule['bitbox02ConnectAuto']>>;
	try {
		unpaired = await withBitbox02Timeout(mod.bitbox02ConnectAuto(undefined), 'connecting');
	} catch (err) {
		// On a bridge-only browser (no WebHID: Firefox/Safari, or any browser on a
		// plain-HTTP origin like Umbrel) a connect failure usually means the
		// bridge isn't installed/running -- say that instead of a bare failure.
		if (!isWebHidAvailable()) {
			throw new Bitbox02Error(
				"Couldn't reach your BitBox02. This browser/connection can't use USB directly, so Hearth connects through the BitBoxBridge app -- install it from bitbox.swiss, make sure it's running, approve this site when it asks, then try again.",
				'unsupported-browser',
				{ cause: err }
			);
		}
		throw toBitbox02Error(err, mod);
	}

	let pairing: Awaited<ReturnType<typeof unpaired.unlockAndPair>>;
	try {
		pairing = await withBitbox02Timeout(unpaired.unlockAndPair(), 'unlocking');
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	try {
		const code = pairing.getPairingCode();
		if (code !== undefined && onPairingCode) onPairingCode(code);
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	let paired: PairedBitBoxType;
	try {
		paired = await withBitbox02Timeout(pairing.waitConfirm(), 'confirming the pairing code');
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	return {
		paired,
		close: () => {
			try {
				paired.close();
			} catch {
				/* releasing the HID/bridge handle is best-effort */
			}
		}
	};
}

const COIN = 'btc' as const;
const MAX_ACCOUNT_NAME = 30; // BitBox02 firmware limit on a registered account name

/** A multisig script config must be REGISTERED on the BitBox02 before it will
 *  sign for it -- the device shows the user the wallet's quorum + every
 *  cosigner key and pins that exact policy on first use (fixing cairn-5kth /
 *  audit F6, a signing-without-registration bug). Idempotent: a device that
 *  already registered this exact config skips straight past, so re-signing
 *  never re-prompts. */
async function maybeRegisterMultisig(
	paired: PairedBitBoxType,
	mod: BitboxModule,
	keypath: string,
	scriptConfig: BitboxMultisigScriptConfig,
	name: string
): Promise<void> {
	const asDeviceConfig = scriptConfig as unknown as Parameters<PairedBitBoxType['btcRegisterScriptConfig']>[1];
	let alreadyRegistered: boolean;
	try {
		alreadyRegistered = await withBitbox02Timeout(
			paired.btcIsScriptConfigRegistered(COIN, asDeviceConfig, keypath),
			'checking the wallet registration'
		);
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}
	if (alreadyRegistered) return;

	const trimmedName = name.trim().slice(0, MAX_ACCOUNT_NAME) || undefined;
	try {
		// 'autoXpubTpub' picks the standard xpub/tpub encoding for the network
		// (mainnet xpub here); a falsy name lets the device prompt for one.
		await withBitbox02Timeout(
			paired.btcRegisterScriptConfig(COIN, asDeviceConfig, keypath, 'autoXpubTpub', trimmedName),
			'registering the multisig wallet'
		);
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}
}

/** Sign a single-sig PSBT with a connected BitBox02. The account keypath and
 *  script config come from the PSBT's OWN `bip32Derivation`, never
 *  hardcoded, matching `ledger.ts`/`trezor.ts`. Returns the fully-signed PSBT
 *  base64 directly -- the device merges its own signature into the PSBT, so
 *  there is no per-input merge-back step here. */
export async function signPsbtWithBitbox02(
	unsignedPsbtBase64: string,
	onPairingCode?: (code: string) => void
): Promise<string> {
	const origin = accountOriginFromPsbtForBitbox02(unsignedPsbtBase64);
	const mod = await loadBitbox();
	const { paired, close } = await connectAndPair(mod, onPairingCode);
	try {
		if (origin.fingerprint !== 0) {
			const deviceFp = await withBitbox02Timeout(paired.rootFingerprint(), 'reading the device fingerprint').catch(
				(e: unknown) => {
					throw toBitbox02Error(e, mod);
				}
			);
			const wantFp = (origin.fingerprint >>> 0).toString(16).padStart(8, '0');
			if (deviceFp.toLowerCase() !== wantFp) {
				throw new Bitbox02Error(
					`This BitBox02 (fingerprint ${deviceFp.toLowerCase()}) doesn't hold this wallet's key (expects ${wantFp}).`,
					'wrong_device'
				);
			}
		}
		const keypath = formatKeyPath(origin.accountPath);
		const scriptConfig = { simpleType: origin.simpleType };
		const signed = await withBitbox02Timeout(
			paired.btcSignPSBT(COIN, unsignedPsbtBase64.trim(), { scriptConfig, keypath }, 'default'),
			'signing the transaction'
		).catch((e: unknown) => {
			throw toBitbox02Error(e, mod);
		});
		return signed;
	} finally {
		close();
	}
}

/** Sign a multisig PSBT with a connected BitBox02. No caller-supplied
 *  cosigner index -- the device's own root fingerprint identifies which of
 *  `keys` it is (matching Ledger/Trezor's cosigner-roster UX: plug in, and
 *  Hearth figures out who you are), then a defense-in-depth xpub read
 *  confirms it's genuinely that key's material (guards a same-fingerprint,
 *  different-passphrase/account device -- the class of bug cairn-86n5 fixed).
 *  Registers the wallet on-device the first time (idempotent), then signs. */
export async function signMultisigPsbtWithBitbox02(
	unsignedPsbtBase64: string,
	keys: MultisigSignKey[],
	threshold: number,
	scriptType: MultisigScriptTypeForBitbox02,
	name: string,
	onPairingCode?: (code: string) => void
): Promise<string> {
	let tx: btc.Transaction;
	try {
		tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch {
		throw new Bitbox02Error('That draft is not a valid transaction to sign.', 'bad_psbt');
	}
	if (tx.inputsLength === 0) throw new Bitbox02Error('That draft has no inputs to sign.', 'bad_psbt');

	const mod = await loadBitbox();
	const { paired, close } = await connectAndPair(mod, onPairingCode);
	try {
		const deviceFp = await withBitbox02Timeout(paired.rootFingerprint(), 'reading the device fingerprint').catch(
			(e: unknown) => {
				throw toBitbox02Error(e, mod);
			}
		);
		const keyIndex = findDeviceKeyIndex(keys, deviceFp);
		const key = keys[keyIndex];
		const keypath = key.path;

		// Defense-in-depth: the fingerprint match above selects a roster slot,
		// but a device sharing that fingerprint under a different passphrase/
		// account would derive different key material -- confirm the actual
		// xpub at this keypath matches before registering or signing under it.
		// Deliberately pass a placeholder fingerprint into bitboxKeyIdentityMatches
		// here (never the device's real, already-matched one): that helper's
		// fingerprint-fallback branch exists for a caller that can't compare
		// xpubs at all, and since findDeviceKeyIndex just matched on fingerprint,
		// re-passing the same real fingerprint would make this check pass
		// unconditionally regardless of the xpub -- silently defeating the very
		// guard it's supposed to be.
		const deviceXpub = await withBitbox02Timeout(
			paired.btcXpub(COIN, keypath, 'xpub', false),
			'reading the account key'
		).catch((e: unknown) => {
			throw toBitbox02Error(e, mod);
		});
		if (!bitboxKeyIdentityMatches(key, { xpub: deviceXpub, fingerprint: '00000000' })) {
			throw new Bitbox02Error(
				`This BitBox02 isn't the key this signature is for -- connect the BitBox02 that holds "${key.fingerprint}"'s key.`,
				'wrong_device'
			);
		}

		const scriptConfig = buildMultisigScriptConfig(keys, keyIndex, threshold, scriptType);
		await maybeRegisterMultisig(paired, mod, keypath, scriptConfig, name);

		const signed = await withBitbox02Timeout(
			paired.btcSignPSBT(COIN, unsignedPsbtBase64.trim(), { scriptConfig, keypath }, 'default'),
			'signing the transaction'
		).catch((e: unknown) => {
			throw toBitbox02Error(e, mod);
		});
		return signed;
	} finally {
		close();
	}
}
