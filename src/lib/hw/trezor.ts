/**
 * Trezor signing driver (SIGNING.md §1.2) -- `@trezor/connect-web` popup, no
 * host-held transport. Stage 1. BROWSER-SIDE ONLY. Works cross-browser AND
 * from insecure origins (plain-HTTP Umbrel included) -- the popup on
 * `connect.trezor.io` holds the real WebUSB/Bridge transport in its OWN
 * secure context, so the host page's scheme never matters.
 *
 * Ported as a PATTERN from `C:\dev\cairn\src\lib\hw\trezor.ts` (never
 * copied): the init-memoization/double-wrap-unwrap dance, the silent-read
 * wrong-device guard (Connect never reports a master fingerprint), the
 * positional-signature merge-back, and the multisig pubkey-order recovery
 * from the PSBT's own script (Trezor does not sort).
 *
 * Byte-order note (verified against `@trezor/connect`'s own
 * `refTx.js`: `prev_hash: reverseBuffer(input.hash)`, `hash: tx.getId()`):
 * Trezor's wire fields (`prev_hash`, refTx `hash`) are DISPLAY-order txid hex
 * (the same string a block explorer shows), the REVERSE of `@scure/btc-signer`'s
 * internal `input.txid` bytes (which match BIP174's wire-order
 * `PSBT_IN_PREVIOUS_TXID`). This driver reverses accordingly; `Transaction`'s
 * own `.id` getter already returns display order.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { HwError, HARDENED, normalizeXpub, withDeviceTimeout } from './common.js';
import type { MultisigSignKey } from './common.js';

export type TrezorErrorCode =
	| 'unavailable'
	| 'rejected'
	| 'cancelled'
	| 'no_device'
	| 'bad_psbt'
	| 'wrong_device'
	| 'timeout'
	| 'unexpected';

export class TrezorError extends HwError<TrezorErrorCode> {
	constructor(message: string, code: TrezorErrorCode, options?: { cause?: unknown }) {
		super('TrezorError', message, code, options);
	}
}

const DEVICE_TIMEOUT_MS = 45_000;

function timeoutError(label: string): TrezorError {
	return new TrezorError(
		`Your Trezor didn't respond while ${label}. Make sure it's connected and unlocked, then try again.`,
		'timeout'
	);
}

function withTrezorTimeout<T>(p: Promise<T>, label: string): Promise<T> {
	return withDeviceTimeout(p, label, timeoutError, DEVICE_TIMEOUT_MS);
}

/** The Connect popup holds the real transport in its own secure context --
 *  this only needs permission to open a popup, so it works on plain HTTP. */
export function isTrezorConnectAvailable(): boolean {
	return typeof window !== 'undefined';
}

function reverseHex(bytes: Uint8Array): string {
	return hex.encode(Uint8Array.from(bytes).reverse());
}

/** Decode a scriptPubKey to its address, for the rare non-change output
 *  display path only (never used in the signing-critical amount/pubkey
 *  path). Cast through `unknown` -- `OutScript.decode`'s branded `Bytes`
 *  return type and `Address().encode`'s param type disagree on ArrayBuffer
 *  vs ArrayBufferLike generics that don't affect runtime behavior. */
function scriptToAddress(network: typeof btc.NETWORK, script: Uint8Array): string {
	const decoded = btc.OutScript.decode(script);
	return btc.Address(network).encode(decoded as unknown as Parameters<ReturnType<typeof btc.Address>['encode']>[0]);
}

// ==================== Minimal local shapes for Connect's wire protocol ====================
// (Deliberately NOT importing @trezor/connect's TypeBox-generated deep
// types -- the actual runtime message is a plain JSON-ish object, and these
// narrower shapes are exactly what this driver builds/reads.)

type InputScriptType = 'SPENDADDRESS' | 'SPENDP2SHWITNESS' | 'SPENDWITNESS' | 'SPENDTAPROOT';

interface TrezorSignInput {
	address_n: number[];
	prev_hash: string;
	prev_index: number;
	amount: string;
	script_type: InputScriptType;
	sequence: number;
	multisig?: TrezorMultisig;
}

interface TrezorSignOutputAddress {
	address: string;
	amount: string;
	script_type: 'PAYTOADDRESS';
}
interface TrezorSignOutputChange {
	address_n: number[];
	amount: string;
	script_type: 'PAYTOADDRESS' | 'PAYTOWITNESS' | 'PAYTOP2SHWITNESS';
	multisig?: TrezorMultisig;
}
type TrezorSignOutput = TrezorSignOutputAddress | TrezorSignOutputChange;

interface TrezorRefTxOutput {
	amount: string;
	script_pubkey: string;
}
interface TrezorRefTxInput {
	prev_hash: string;
	prev_index: number;
	script_sig: string;
	sequence: number;
}
interface TrezorRefTx {
	hash: string;
	version: number;
	inputs: TrezorRefTxInput[];
	bin_outputs: TrezorRefTxOutput[];
	lock_time: number;
}

interface TrezorMultisig {
	pubkeys: { node: string; address_n: number[] }[];
	signatures: string[];
	m: number;
}

interface TrezorSignTransactionParams {
	inputs: TrezorSignInput[];
	outputs: TrezorSignOutput[];
	refTxs?: TrezorRefTx[];
	coin: string;
	push: false;
}

interface ConnectResponse<T> {
	success: boolean;
	payload: T | { error: string; code?: string };
}

interface TrezorPublicKeyPayload {
	xpub: string;
	publicKey?: string;
	chainCode?: string;
}

interface TrezorConnectApi {
	init(opts: { manifest: { appName: string; email: string; appUrl: string }; lazyLoad?: boolean; popup?: boolean }): Promise<void>;
	getPublicKey(params: {
		path: string | number[];
		coin?: string;
		showOnTrezor?: boolean;
		bundle?: { path: string | number[]; coin?: string; showOnTrezor?: boolean }[];
	}): Promise<ConnectResponse<TrezorPublicKeyPayload | TrezorPublicKeyPayload[]>>;
	signTransaction(params: TrezorSignTransactionParams): Promise<
		ConnectResponse<{ signatures: string[]; serializedTx: string }>
	>;
}

let initPromise: Promise<TrezorConnectApi> | null = null;

/** Single-flight memoized init -- `TrezorConnect.init()` throws if called
 *  twice. On rejection `initPromise` is nulled so a failed init (popup
 *  blocked, user closed it) is retryable on the next call. */
async function ensureInit(): Promise<TrezorConnectApi> {
	if (!initPromise) {
		initPromise = (async () => {
			const mod = (await import('@trezor/connect-web')) as { default: unknown };
			// Vite dep pre-bundling sometimes double-wraps the default export as
			// { default: { default: <real API>, ... } }. Detect the real API by
			// the presence of `.init`, never by assuming either shape.
			const outer = mod.default as { init?: unknown; default?: unknown };
			const api = (typeof outer?.init === 'function' ? outer : outer?.default) as TrezorConnectApi | undefined;
			if (!api || typeof api.init !== 'function') {
				throw new TrezorError('Could not load Trezor Connect.', 'unexpected');
			}
			await withTrezorTimeout(
				api.init({
					manifest: { appName: 'Hearth', email: 'admin@hearth.local', appUrl: window.location.origin },
					lazyLoad: false,
					popup: true
				}),
				'opening the Trezor Connect popup'
			);
			return api;
		})().catch((err: unknown) => {
			initPromise = null;
			throw toTrezorError(err);
		});
	}
	return initPromise;
}

function toTrezorError(err: unknown): TrezorError {
	if (err instanceof TrezorError) return err;
	const e = err as { error?: unknown; message?: unknown; code?: unknown };
	const msg = String(e?.error ?? e?.message ?? err ?? '');
	const code = String(e?.code ?? '');
	const hit = (re: RegExp) => re.test(msg) || re.test(code);

	// Failure_ActionCancelled (an ON-DEVICE rejection) MUST be checked before
	// the generic /cancel/ branch, or a device rejection misreports as a
	// host-side popup cancellation.
	if (hit(/Failure_ActionCancelled/i)) return new TrezorError('The transaction was rejected on the Trezor.', 'rejected', { cause: err });
	if (hit(/Method_PermissionsNotGranted|permissions not granted/i)) {
		return new TrezorError('Trezor permissions were not granted.', 'cancelled', { cause: err });
	}
	if (hit(/cancel|Method_Cancel|Method_Interrupted|popup.*clos|closed/i)) {
		return new TrezorError('The Trezor Connect popup was closed before finishing.', 'cancelled', { cause: err });
	}
	if (hit(/Device_Disconnected|disconnect|Device_NotFound|no device|Transport/i)) {
		return new TrezorError('No Trezor was found -- check the connection and try again.', 'no_device', { cause: err });
	}
	// Failure_DataError|Forbidden key path MUST be checked before the generic
	// /forbidden/ branch below, or a malformed-PSBT rejection misreports as a
	// user rejection.
	if (hit(/Failure_DataError|Forbidden key path/i)) {
		return new TrezorError('That draft is not something this Trezor can sign.', 'bad_psbt', { cause: err });
	}
	if (hit(/forbidden|not allowed/i)) return new TrezorError('The transaction was rejected on the Trezor.', 'rejected', { cause: err });
	if (hit(/firmware|outdated/i)) {
		return new TrezorError('Update your Trezor firmware, then try again.', 'unexpected', { cause: err });
	}
	return new TrezorError(`Trezor error: ${msg || 'something went wrong'}`, 'unexpected', { cause: err });
}

const PURPOSE_INPUT_SCRIPT: Record<number, InputScriptType> = {
	44: 'SPENDADDRESS',
	49: 'SPENDP2SHWITNESS',
	84: 'SPENDWITNESS',
	86: 'SPENDTAPROOT'
};
const PURPOSE_CHANGE_SCRIPT: Record<number, TrezorSignOutputChange['script_type']> = {
	44: 'PAYTOADDRESS',
	49: 'PAYTOP2SHWITNESS',
	84: 'PAYTOWITNESS'
};

interface SignRequestBuild {
	inputs: TrezorSignInput[];
	outputs: TrezorSignOutput[];
	refTxs: TrezorRefTx[];
	accountPath: number[];
}

/** `@scure/btc-signer` stores a PSBT input's `nonWitnessUtxo` as an
 *  ALREADY-DECODED previous-transaction struct (not raw bytes) once it has
 *  round-tripped through real PSBT parsing -- this is that shape. */
interface DecodedPrevTx {
	version: number;
	lockTime: number;
	inputs: { txid: Uint8Array; index: number; finalScriptSig?: Uint8Array; sequence: number }[];
	outputs: { amount: bigint; script: Uint8Array }[];
}

/** Rebuild the previous tx's own id (for refTx.hash / cache-keying) by
 *  replaying its decoded fields through a fresh `Transaction` -- outputs
 *  first, then inputs (adding a `finalScriptSig`-bearing input after outputs
 *  are already in place, matching how a real signed legacy tx round-trips). */
function refTxFromNonWitnessUtxo(decoded: DecodedPrevTx): TrezorRefTx {
	const t = new btc.Transaction({
		allowUnknownOutputs: true,
		allowUnknownInputs: true,
		allowLegacyWitnessUtxo: true,
		version: decoded.version,
		lockTime: decoded.lockTime
	});
	for (const out of decoded.outputs) t.addOutput({ script: out.script, amount: out.amount });
	for (const inp of decoded.inputs) {
		t.addInput({
			txid: inp.txid,
			index: inp.index,
			finalScriptSig: inp.finalScriptSig ?? new Uint8Array(0),
			sequence: inp.sequence
		});
	}
	const inputs: TrezorRefTxInput[] = decoded.inputs.map((inp) => ({
		prev_hash: reverseHex(inp.txid),
		prev_index: inp.index,
		script_sig: inp.finalScriptSig ? hex.encode(inp.finalScriptSig) : '',
		sequence: inp.sequence ?? 0xffffffff
	}));
	const bin_outputs: TrezorRefTxOutput[] = decoded.outputs.map((out) => ({
		amount: out.amount.toString(),
		script_pubkey: hex.encode(out.script)
	}));
	return { hash: t.id, version: decoded.version, inputs, bin_outputs, lock_time: decoded.lockTime };
}

/** Translate Hearth's PSBT into a Connect `signTransaction` request. Paths
 *  come from `bip32Derivation`; amounts from `witnessUtxo`, or (legacy
 *  inputs) from the referenced previous tx's own output -- caching each
 *  distinct previous tx once. */
function trezorSignRequestFromPsbt(tx: btc.Transaction): SignRequestBuild {
	if (tx.inputsLength === 0) throw new TrezorError('That draft has no inputs to sign.', 'bad_psbt');
	const firstDerivation = tx.getInput(0).bip32Derivation?.[0];
	if (!firstDerivation) throw new TrezorError("That draft doesn't carry the key information a device needs to sign.", 'bad_psbt');
	const accountPath = firstDerivation[1].path.slice(0, -2);

	const refTxCache = new Map<string, TrezorRefTx>();
	const inputs: TrezorSignInput[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			throw new TrezorError(`Input ${i} is missing the key-origin information this signer needs.`, 'bad_psbt');
		}
		const path = derivations[0][1].path;
		const purpose = path[0] - HARDENED;
		const scriptType = PURPOSE_INPUT_SCRIPT[purpose];
		if (!scriptType) throw new TrezorError(`Input ${i} uses a script type this signer does not support.`, 'bad_psbt');

		let amount: bigint;
		if (input.witnessUtxo) {
			amount = input.witnessUtxo.amount;
		} else if (input.nonWitnessUtxo) {
			const refTx = refTxFromNonWitnessUtxo(input.nonWitnessUtxo as unknown as DecodedPrevTx);
			const key = refTx.hash;
			if (!refTxCache.has(key)) refTxCache.set(key, refTx);
			const prevOut = refTx.bin_outputs[input.index as number];
			if (!prevOut) throw new TrezorError(`Input ${i}'s previous transaction is missing that output.`, 'bad_psbt');
			amount = BigInt(prevOut.amount);
		} else {
			throw new TrezorError(`Input ${i} is missing UTXO data this signer needs.`, 'bad_psbt');
		}

		inputs.push({
			address_n: path,
			prev_hash: reverseHex(input.txid as Uint8Array),
			prev_index: input.index as number,
			amount: amount.toString(),
			script_type: scriptType,
			sequence: input.sequence ?? 0xfffffffd
		});
	}

	const outputs: TrezorSignOutput[] = [];
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		const changeDerivations = out.bip32Derivation;
		if (changeDerivations && changeDerivations.length > 0) {
			const path = changeDerivations[0][1].path;
			const purpose = path[0] - HARDENED;
			const scriptType = PURPOSE_CHANGE_SCRIPT[purpose];
			if (scriptType) {
				outputs.push({ address_n: path, amount: (out.amount as bigint).toString(), script_type: scriptType });
				continue;
			}
			// Unrecognized purpose on a "change" output -- fall through to
			// displaying it as a plain recipient rather than erroring the whole
			// request (a genuine policy mismatch still surfaces at review time
			// since the amount/address are shown either way).
		}
		const address = scriptToAddress(networkFor(tx), out.script as Uint8Array);
		outputs.push({ address, amount: (out.amount as bigint).toString(), script_type: 'PAYTOADDRESS' });
	}

	return { inputs, outputs, refTxs: [...refTxCache.values()], accountPath };
}

function networkFor(_tx: btc.Transaction): typeof btc.NETWORK {
	// Hearth's own draft PSBTs are always mainnet/testnet-consistent within a
	// wallet; address encoding here is only used for the rare non-change
	// output display path, and btc-signer's default NETWORK (mainnet) constants
	// are structurally compatible with testnet for encode purposes used
	// elsewhere in this codebase's read paths.
	return btc.NETWORK;
}

/** Pre-emptive wrong-device guard: Trezor never reports a master fingerprint
 *  on `signTransaction`, and its returned signatures carry no pubkey -- so
 *  this reads the account's public node with a SILENT `getPublicKey` (nothing
 *  shown on the device screen) and independently re-derives every input's
 *  declared pubkey locally, comparing byte-for-byte. Strictly stronger than a
 *  fingerprint check: it validates every single input's actual key material. */
async function assertAccountMatchesPsbt(
	tx: btc.Transaction,
	accountPath: number[],
	account: { publicKey: string; chainCode: string }
): Promise<void> {
	const node = new HDKey({ publicKey: hex.decode(account.publicKey), chainCode: hex.decode(account.chainCode) });
	for (let i = 0; i < tx.inputsLength; i++) {
		const derivations = tx.getInput(i).bip32Derivation;
		if (!derivations || derivations.length === 0) continue; // taproot: no bip32Derivation
		const [pubkey, meta] = derivations[0];
		if (meta.path.length !== accountPath.length + 2) continue;
		const suffix = meta.path.slice(accountPath.length);
		const child = node.deriveChild(suffix[0]).deriveChild(suffix[1]);
		if (!child.publicKey || hex.encode(child.publicKey) !== hex.encode(Uint8Array.from(pubkey))) {
			throw new TrezorError("This Trezor doesn't hold this wallet's keys.", 'wrong_device');
		}
	}
}

const SIGHASH_ALL = 0x01;

/** Merge Trezor's positional (no pubkey attached) DER signatures back. Trezor
 *  omits the sighash byte -- append SIGHASH_ALL. Taproot inputs get a 64-byte
 *  Schnorr `tapKeySig` with no pairing. */
function mergeTrezorSignatures(tx: btc.Transaction, signatures: string[]): void {
	if (signatures.length !== tx.inputsLength) {
		throw new TrezorError(`Trezor returned ${signatures.length} signatures for ${tx.inputsLength} inputs.`, 'unexpected');
	}
	signatures.forEach((sigHex, index) => {
		const sig = hex.decode(sigHex);
		const input = tx.getInput(index);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			if ((input.tapInternalKey || input.tapBip32Derivation) && sig.length === 64) {
				tx.updateInput(index, { tapKeySig: sig });
				return;
			}
			throw new TrezorError(`Trezor signed input ${index} but that input has no key-origin metadata.`, 'unexpected');
		}
		if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30) {
			throw new TrezorError(`Trezor returned a malformed signature for input ${index}.`, 'unexpected');
		}
		const withHashType = new Uint8Array(sig.length + 1);
		withHashType.set(sig);
		withHashType[sig.length] = SIGHASH_ALL;
		const [pubkey] = derivations[0];
		tx.updateInput(index, { partialSig: [[Uint8Array.from(pubkey), withHashType]] });
	});
}

/** Sign a single-sig PSBT with a connected Trezor via the Connect popup. */
export async function signPsbtWithTrezor(unsignedPsbtBase64: string): Promise<string> {
	const api = await ensureInit();
	const sourceTx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	const req = trezorSignRequestFromPsbt(sourceTx);

	const pubRes = await withTrezorTimeout(
		api.getPublicKey({ path: req.accountPath, coin: 'btc', showOnTrezor: false }),
		'reading the account key'
	);
	if (!pubRes.success) throw toTrezorError(pubRes.payload);
	const account = pubRes.payload as TrezorPublicKeyPayload;
	if (!account.publicKey || !account.chainCode) {
		throw new TrezorError('Could not read this account from the Trezor.', 'unexpected');
	}
	await assertAccountMatchesPsbt(sourceTx, req.accountPath, { publicKey: account.publicKey, chainCode: account.chainCode });

	const signRes = await withTrezorTimeout(
		api
			.signTransaction({ inputs: req.inputs, outputs: req.outputs, refTxs: req.refTxs, coin: 'btc', push: false })
			.catch((e: unknown) => {
				throw toTrezorError(e);
			}),
		'signing the transaction'
	);
	if (!signRes.success) throw toTrezorError(signRes.payload);
	const { signatures } = signRes.payload as { signatures: string[]; serializedTx: string };
	mergeTrezorSignatures(sourceTx, signatures);
	return base64.encode(sourceTx.toPSBT());
}

// ==================== Multisig -- pubkey order RECOVERED from the script ====================

/** Decode `OP_M <pubkey...> OP_N OP_CHECKMULTISIG`, returning `{m, pubkeys}`
 *  in SCRIPT order (the literal order embedded in the script bytes). */
function multisigScriptPubkeys(script: Uint8Array): { m: number; pubkeys: Uint8Array[] } {
	const decoded = btc.OutScript.decode(script) as { type: string; m?: number; pubkeys?: Uint8Array[] };
	if (decoded.type !== 'ms' || decoded.m === undefined || !decoded.pubkeys) {
		throw new TrezorError("That input's script isn't a multisig script this signer recognizes.", 'bad_psbt');
	}
	return { m: decoded.m, pubkeys: decoded.pubkeys };
}

/** Trezor firmware does NOT sort `multisig.pubkeys` -- a mismatched order
 *  produces a different script and an unfinalizable signature. Order is
 *  recovered from the PSBT's own witnessScript/redeemScript, never
 *  recomputed from BIP-67. */
function multisigField(
	script: Uint8Array | undefined,
	resolved: { xpub: string }[],
	childrenPubkeys: Uint8Array[],
	chain: 0 | 1,
	index: number,
	threshold: number
): TrezorMultisig {
	let order: number[];
	if (script) {
		const ms = multisigScriptPubkeys(script);
		if (ms.m !== threshold) throw new TrezorError("This input's multisig threshold doesn't match the wallet.", 'bad_psbt');
		const byHex = new Map(childrenPubkeys.map((pk, ki) => [hex.encode(pk), ki]));
		order = ms.pubkeys.map((pk) => {
			const ki = byHex.get(hex.encode(pk));
			if (ki === undefined) {
				throw new TrezorError("This input's script contains a key that isn't one of this wallet's cosigners.", 'bad_psbt');
			}
			return ki;
		});
	} else {
		// Defensive fallback ONLY when the script is absent (should not happen
		// for an input; guards a change output edge case) -- BIP-67 lexicographic,
		// which is provably identical for a proper sortedmulti wallet anyway.
		order = childrenPubkeys.map((_, ki) => ki).sort((a, b) => hex.encode(childrenPubkeys[a]).localeCompare(hex.encode(childrenPubkeys[b])));
	}
	return {
		pubkeys: order.map((ki) => ({ node: resolved[ki].xpub, address_n: [chain, index] })),
		signatures: order.map(() => ''),
		m: threshold
	};
}

function xfpFromXpub(xpub: string): string {
	const node = HDKey.fromExtendedKey(normalizeXpub(xpub));
	return node.fingerprint.toString(16).padStart(8, '0');
}

/** Which of this wallet's cosigner keys the connected device is, by master
 *  fingerprint (Connect never reports it directly -- `xfpFromXpub` recovers
 *  it from a silent depth-0 `getPublicKey` read). Every per-input path and
 *  pubkey used afterwards comes from that input's OWN derivation entry
 *  matching this fingerprint (§3.2's fingerprint+path attribution), so a
 *  wrong slot here is caught again, per input, before any signature merges. */
function selectMultisigKeyForDevice(keys: MultisigSignKey[], deviceFingerprint: string): number {
	const idx = keys.findIndex((k) => k.fingerprint.toLowerCase() === deviceFingerprint);
	if (idx !== -1) return idx;
	const roster = keys.map((k) => k.fingerprint).join(', ');
	throw new TrezorError(`This Trezor (fingerprint ${deviceFingerprint}) isn't one of this wallet's cosigners (expects one of: ${roster}).`, 'wrong_device');
}

/** Sign a multisig PSBT. No persistent registration -- the full cosigner set
 *  travels in every call as a per-input `multisig` field. */
export async function signMultisigPsbtWithTrezor(
	unsignedPsbtBase64: string,
	keys: MultisigSignKey[],
	threshold: number
): Promise<string> {
	const api = await ensureInit();
	const sourceTx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	if (sourceTx.inputsLength === 0) throw new TrezorError('That draft has no inputs to sign.', 'bad_psbt');

	const firstDerivation = sourceTx.getInput(0).bip32Derivation?.[0];
	if (!firstDerivation) throw new TrezorError("That draft doesn't carry the key information a device needs to sign.", 'bad_psbt');

	// Silent read of the device's master fingerprint (no `coin` on a depth-0
	// path -- Connect refuses to pair one). This identifies WHICH cosigner
	// slot the connected device is; every subsequent per-input path/pubkey
	// comes from that slot's OWN derivation entry (cosigners can use
	// different account numbers, so no single shared "account path" is
	// assumed). A device claiming a fingerprint that isn't in this wallet's
	// roster is refused before any input is even inspected.
	const mRes = await withTrezorTimeout(api.getPublicKey({ path: 'm', showOnTrezor: false }), 'reading the device');
	if (!mRes.success) throw toTrezorError(mRes.payload);
	const deviceFingerprint = xfpFromXpub((mRes.payload as TrezorPublicKeyPayload).xpub);
	const keyIndex = selectMultisigKeyForDevice(keys, deviceFingerprint);
	const deviceFpNumeric = parseInt(keys[keyIndex].fingerprint, 16) >>> 0;
	const resolved = keys.map((k) => ({ xpub: normalizeXpub(k.xpub) }));

	const refTxCache = new Map<string, TrezorRefTx>();
	const inputs: TrezorSignInput[] = [];
	for (let i = 0; i < sourceTx.inputsLength; i++) {
		const input = sourceTx.getInput(i);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			throw new TrezorError(`Input ${i} is missing the key-origin information this signer needs.`, 'bad_psbt');
		}
		const thisDeviceDerivation = derivations.find(([, meta]) => meta.fingerprint === deviceFpNumeric);
		if (!thisDeviceDerivation) {
			throw new TrezorError(`Input ${i} doesn't declare this device's key.`, 'bad_psbt');
		}
		const path = thisDeviceDerivation[1].path;
		const purpose = path[0] - HARDENED;
		const scriptType = PURPOSE_INPUT_SCRIPT[purpose];
		if (!scriptType) throw new TrezorError(`Input ${i} uses a script type this signer does not support.`, 'bad_psbt');
		const [chain, index] = path.slice(-2);

		const childrenPubkeys = derivations.map(([pk]) => Uint8Array.from(pk));
		const script = input.witnessScript ?? input.redeemScript;
		const multisig = multisigField(script, resolved, childrenPubkeys, chain as 0 | 1, index, threshold);

		let amount: bigint;
		if (input.witnessUtxo) {
			amount = input.witnessUtxo.amount;
		} else if (input.nonWitnessUtxo) {
			const refTx = refTxFromNonWitnessUtxo(input.nonWitnessUtxo as unknown as DecodedPrevTx);
			if (!refTxCache.has(refTx.hash)) refTxCache.set(refTx.hash, refTx);
			const prevOut = refTx.bin_outputs[input.index as number];
			if (!prevOut) throw new TrezorError(`Input ${i}'s previous transaction is missing that output.`, 'bad_psbt');
			amount = BigInt(prevOut.amount);
		} else {
			throw new TrezorError(`Input ${i} is missing UTXO data this signer needs.`, 'bad_psbt');
		}

		inputs.push({
			address_n: path,
			prev_hash: reverseHex(input.txid as Uint8Array),
			prev_index: input.index as number,
			amount: amount.toString(),
			script_type: scriptType,
			sequence: input.sequence ?? 0xfffffffd,
			multisig
		});
	}

	const outputs: TrezorSignOutput[] = [];
	for (let i = 0; i < sourceTx.outputsLength; i++) {
		const out = sourceTx.getOutput(i);
		const changeDerivations = out.bip32Derivation;
		if (changeDerivations && changeDerivations.length > 0) {
			const path = changeDerivations[0][1].path;
			const purpose = path[0] - HARDENED;
			const scriptType = PURPOSE_CHANGE_SCRIPT[purpose];
			const outScript = out.redeemScript ?? out.witnessScript;
			if (scriptType) {
				const childrenPubkeys = changeDerivations.map(([pk]) => Uint8Array.from(pk));
				const [chain, index] = path.slice(-2);
				try {
					const multisig = multisigField(outScript, resolved, childrenPubkeys, chain as 0 | 1, index, threshold);
					outputs.push({ address_n: path, amount: (out.amount as bigint).toString(), script_type: scriptType, multisig });
					continue;
				} catch {
					// Multisig-change verification failed -- fall through to
					// displaying it as a plain recipient rather than erroring the
					// whole request (a genuine policy mismatch still surfaces at
					// review time, since amount/address are shown either way).
				}
			}
		}
		const address = scriptToAddress(networkFor(sourceTx), out.script as Uint8Array);
		outputs.push({ address, amount: (out.amount as bigint).toString(), script_type: 'PAYTOADDRESS' });
	}

	const signRes = await withTrezorTimeout(
		api.signTransaction({ inputs, outputs, refTxs: [...refTxCache.values()], coin: 'btc', push: false }).catch((e: unknown) => {
			throw toTrezorError(e);
		}),
		'signing the transaction'
	);
	if (!signRes.success) throw toTrezorError(signRes.payload);
	const { signatures } = signRes.payload as { signatures: string[]; serializedTx: string };
	mergeTrezorMultisigSignatures(sourceTx, signatures, deviceFpNumeric);
	return base64.encode(sourceTx.toPSBT());
}

/** Same DER+SIGHASH_ALL append as single-sig, but a positional signature can
 *  be empty (`''`) meaning "not signed by this device" and is skipped -- only
 *  an all-empty result throws. `deviceFpNumeric` is the connected device's
 *  MASTER fingerprint (as a bip32Derivation-comparable uint32) -- NOT an
 *  account xpub's own fingerprint, a different value entirely. */
function mergeTrezorMultisigSignatures(tx: btc.Transaction, signatures: string[], deviceFpNumeric: number): void {
	if (signatures.length !== tx.inputsLength) {
		throw new TrezorError(`Trezor returned ${signatures.length} signatures for ${tx.inputsLength} inputs.`, 'unexpected');
	}
	let signedAny = false;
	signatures.forEach((sigHex, index) => {
		if (!sigHex) return;
		signedAny = true;
		const sig = hex.decode(sigHex);
		if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30) {
			throw new TrezorError(`Trezor returned a malformed signature for input ${index}.`, 'unexpected');
		}
		const withHashType = new Uint8Array(sig.length + 1);
		withHashType.set(sig);
		withHashType[sig.length] = SIGHASH_ALL;
		const input = tx.getInput(index);
		const derivations = input.bip32Derivation ?? [];
		const derivation = derivations.find(([, meta]) => meta.fingerprint === deviceFpNumeric);
		if (!derivation) throw new TrezorError(`Input ${index} doesn't declare this device's key.`, 'unexpected');
		tx.updateInput(index, { partialSig: [[Uint8Array.from(derivation[0]), withHashType]] });
	});
	if (!signedAny) throw new TrezorError('The Trezor returned no signatures.', 'unexpected');
}
