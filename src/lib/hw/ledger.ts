/**
 * Ledger signing driver (SIGNING.md §1.1) -- WebHID + hw-app-btc v2 (BIP-388).
 * Stage 1. BROWSER-SIDE ONLY. Every vendor `@ledgerhq/*` module is lazy-
 * imported inside the function that needs it (`await import(...)`) so SSR
 * and non-Ledger users never pay to load them, and the browser globals
 * (`navigator.hid`) are only touched after a click.
 *
 * Ported as a PATTERN from `C:\dev\cairn\src\lib\hw\ledger.ts` (never copied):
 * the BIP-388 hand-built wallet-policy registration in particular, since the
 * installed `@ledgerhq/hw-app-btc` only exposes single-key/unnamed policies
 * with no `registerWallet` method.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HwError, HARDENED, formatKeyPath, normalizeXpub, parseKeyPath, withDeviceTimeout } from './common.js';
import { isWebHidAvailable } from './secureContext.js';
import type { MultisigSignKey } from './common.js';

export type LedgerErrorCode =
	| 'unavailable'
	| 'app_not_open'
	| 'device_locked'
	| 'rejected'
	| 'no_device'
	| 'bad_psbt'
	| 'wrong_device'
	| 'policy_unregistered'
	| 'timeout'
	| 'unexpected';

export class LedgerError extends HwError<LedgerErrorCode> {
	constructor(message: string, code: LedgerErrorCode, options?: { cause?: unknown }) {
		super('LedgerError', message, code, options);
	}
}

const DEVICE_TIMEOUT_MS = 45_000;

function timeoutError(label: string): LedgerError {
	return new LedgerError(
		`Your Ledger didn't respond while ${label}. Make sure it's unlocked, the Bitcoin app is open, and try again.`,
		'timeout'
	);
}

function withLedgerTimeout<T>(p: Promise<T>, label: string): Promise<T> {
	return withDeviceTimeout(p, label, timeoutError, DEVICE_TIMEOUT_MS);
}

/** Install the Node globals (`Buffer`, a minimal `process` stub) the
 *  `@ledgerhq/*` vendor chain needs at MODULE-EVALUATION time -- must finish
 *  BEFORE the vendor `import()` calls start. `hw-transport-webhid`'s HID
 *  framing calls `Buffer.alloc` at module scope, and `hw-app-btc`'s
 *  bip32->ripemd160->readable-stream chain reads `process.browser`/
 *  `process.version` at module scope and calls `process.nextTick` at
 *  runtime. Idempotent -- a no-op under Node/Vitest where both already exist. */
async function ensureNodeGlobals(): Promise<void> {
	const g = globalThis as { Buffer?: unknown; process?: unknown };
	if (typeof g.Buffer === 'undefined') {
		const { Buffer } = await import('buffer');
		g.Buffer = Buffer;
	}
	if (typeof g.process === 'undefined') {
		g.process = {
			browser: true,
			env: {},
			version: '',
			nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args))
		};
	}
}

function toU8(v: Uint8Array | Buffer | string): Uint8Array {
	if (typeof v === 'string') return hex.decode(v);
	return Uint8Array.from(v);
}

function fingerprintToBuffer(fp: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, fp >>> 0, false);
	return out;
}

function bytesToFpHex(b: Uint8Array | Buffer): string {
	return Array.from(Uint8Array.from(b))
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
}

function buffersEqual(a: Uint8Array | Buffer, b: Uint8Array): boolean {
	const ua = Uint8Array.from(a);
	if (ua.length !== b.length) return false;
	for (let i = 0; i < ua.length; i++) if (ua[i] !== b[i]) return false;
	return true;
}

type DefaultDescriptorTemplate = 'pkh(@0/**)' | 'sh(wpkh(@0/**))' | 'wpkh(@0/**)' | 'tr(@0/**)';
const PURPOSE_TEMPLATE: Record<number, DefaultDescriptorTemplate> = {
	44: 'pkh(@0/**)',
	49: 'sh(wpkh(@0/**))',
	84: 'wpkh(@0/**)',
	86: 'tr(@0/**)'
};

interface AccountOrigin {
	fingerprint: number;
	accountPath: number[];
	template: DefaultDescriptorTemplate;
}

/** Derive the account policy (fingerprint, path, descriptor template) from
 *  the PSBT's OWN `bip32Derivation` -- never hardcoded. Only reads the first
 *  input's first derivation entry (Hearth, like cairn, is single-account per
 *  wallet). Fails fast (before touching any device) on a PSBT that doesn't
 *  carry key-origin metadata. */
export function accountOriginFromPsbt(unsignedPsbtBase64: string): AccountOrigin {
	let tx: btc.Transaction;
	try {
		tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch {
		throw new LedgerError('That draft is not a valid transaction to sign.', 'bad_psbt');
	}
	if (tx.inputsLength === 0) throw new LedgerError('That draft has no inputs to sign.', 'bad_psbt');
	const input = tx.getInput(0);
	const derivations = input.bip32Derivation;
	if (!derivations || derivations.length === 0) {
		throw new LedgerError("That draft doesn't carry the key information a device needs to sign.", 'bad_psbt');
	}
	const [, meta] = derivations[0];
	const fullPath = meta.path;
	if (fullPath.length < 3) throw new LedgerError('That draft has an unusual derivation path.', 'bad_psbt');
	const accountPath = fullPath.slice(0, -2);
	const purpose = accountPath[0] - HARDENED;
	const template = PURPOSE_TEMPLATE[purpose];
	if (!template) throw new LedgerError('That draft uses a script type this signer does not support.', 'bad_psbt');
	return { fingerprint: meta.fingerprint, accountPath, template };
}

/** Merge a Ledger `signPsbt` result back into the source transaction.
 *  Non-taproot: pair the signature with the pubkey from that input's own
 *  `bip32Derivation[0]` (never device-claimed). Taproot inputs carry no
 *  `bip32Derivation` (they use `tapBip32Derivation`/`tapInternalKey`
 *  instead) -- the branch is decided by presence/absence of `bip32Derivation`,
 *  and a taproot sig goes straight into `tapKeySig` with no pubkey pairing. */
export function mergeSignatures(tx: btc.Transaction, sigs: Map<number, Uint8Array | Buffer>): void {
	sigs.forEach((sig, index) => {
		const sigBytes = toU8(sig as Uint8Array);
		const input = tx.getInput(index);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			if (input.tapInternalKey || input.tapBip32Derivation) {
				tx.updateInput(index, { tapKeySig: sigBytes });
				return;
			}
			throw new LedgerError(`Ledger signed input ${index} but that input has no key-origin metadata.`, 'unexpected');
		}
		const [pubkey] = derivations[0];
		tx.updateInput(index, { partialSig: [[Uint8Array.from(pubkey), sigBytes]] });
	});
}

function toLedgerError(err: unknown): LedgerError {
	if (err instanceof LedgerError) return err;
	const e = err as { message?: unknown; name?: unknown; statusCode?: unknown };
	const msg = String(e?.message ?? err ?? '');
	const name = String(e?.name ?? '');
	const code = typeof e?.statusCode === 'number' ? e.statusCode : null;
	const hit = (re: RegExp, statusCode?: number) => re.test(msg) || (statusCode != null && code === statusCode);

	if (hit(/0x6e0[01]|0x6d00|0x6511|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i, 0x6e01)) {
		return new LedgerError('Open the Bitcoin app on your Ledger, then connect again.', 'app_not_open', { cause: err });
	}
	if (hit(/0x6985|0x5501|denied|rejected|CONDITIONS_OF_USE_NOT_SATISFIED/i, 0x6985)) {
		return new LedgerError('The transaction was rejected on the Ledger.', 'rejected', { cause: err });
	}
	if (hit(/0x5515|0x6b0c|locked|LOCKED_DEVICE/i, 0x5515)) {
		return new LedgerError('Unlock your Ledger and try again.', 'device_locked', { cause: err });
	}
	if (/no device selected|must select|cancel|did not select|requestDevice|NotFoundError/i.test(msg) || name === 'NotFoundError') {
		return new LedgerError('No Ledger was selected.', 'no_device', { cause: err });
	}
	if (/already open|InvalidStateError|in use|DisconnectedDevice|disconnect/i.test(msg)) {
		return new LedgerError(
			'Your Ledger disconnected or is busy. Reconnect with the Bitcoin app open and try again.',
			'unexpected',
			{ cause: err }
		);
	}
	return new LedgerError(`Ledger error: ${msg || 'something went wrong'}`, 'unexpected', { cause: err });
}

/** Sign a single-sig PSBT with a connected Ledger. Opens the browser's
 *  WebHID device picker. Uses the unnamed default wallet policy -- no
 *  registration required by the app for single-key wallets. */
export async function signPsbtWithLedger(unsignedPsbtBase64: string): Promise<string> {
	if (!isWebHidAvailable()) {
		throw new LedgerError('Ledger connects over a secure browser channel that this browser/origin does not have.', 'unavailable');
	}
	const origin = accountOriginFromPsbt(unsignedPsbtBase64);
	const sourceTx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));

	await ensureNodeGlobals();
	const [{ default: TransportWebHID }, { AppClient }, { WalletPolicy, createKey }, { PsbtV2 }] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient.js'),
		import('@ledgerhq/hw-app-btc/lib/newops/policy.js'),
		import('@ledgerhq/psbtv2')
	]);

	let transport: Awaited<ReturnType<typeof TransportWebHID.create>> | undefined;
	try {
		transport = await withLedgerTimeout(TransportWebHID.create().catch((e: unknown) => { throw toLedgerError(e); }), 'connecting');
		const client = new AppClient(transport);
		const masterFp = await withLedgerTimeout(
			client.getMasterFingerprint().catch((e: unknown) => { throw toLedgerError(e); }),
			'reading the device fingerprint'
		);
		const accountXpub = await withLedgerTimeout(
			client.getExtendedPubkey(false, origin.accountPath).catch((e: unknown) => { throw toLedgerError(e); }),
			'reading the account key'
		);

		if (origin.fingerprint !== 0) {
			const wantFp = fingerprintToBuffer(origin.fingerprint);
			if (!buffersEqual(masterFp, wantFp)) {
				throw new LedgerError(
					`This Ledger (fingerprint ${bytesToFpHex(masterFp)}) doesn't hold this wallet's key (expects ${bytesToFpHex(wantFp)}).`,
					'wrong_device'
				);
			}
		}

		const key = createKey(masterFp, origin.accountPath, accountXpub);
		const policy = new WalletPolicy(origin.template, key);
		const psbtV2 = PsbtV2.fromV0(Buffer.from(sourceTx.toPSBT()));
		const sigs = await withLedgerTimeout(
			client.signPsbt(psbtV2, policy, null, () => {}).catch((e: unknown) => { throw toLedgerError(e); }),
			'signing the transaction'
		);
		mergeSignatures(sourceTx, sigs);
		return base64.encode(sourceTx.toPSBT());
	} finally {
		await transport?.close().catch(() => {});
	}
}

// ==================== Multisig (BIP-388 wallet policy) ====================

/** SLIP-132/plain multisig script types Hearth's wallet engine builds. */
export type MultisigScriptTypeForPolicy = 'p2sh' | 'p2sh-p2wsh' | 'p2wsh';

interface MultisigWalletPolicy {
	name: string;
	template: string;
	keys: string[];
}

/** Case-sensitive xpub-substring sort -- NEVER normalize case. Registration
 *  and every later signing call must reproduce the identical order or the
 *  device rejects the stored HMAC (this order only affects `@i` numbering
 *  and the registration preimage; sortedmulti re-sorts pubkeys at
 *  script-build time independently, so addresses are unaffected). */
function compareMultisigPolicyKeys(a: string, b: string): number {
	const ax = a.slice(a.indexOf(']') + 1);
	const bx = b.slice(b.indexOf(']') + 1);
	return ax < bx ? -1 : ax > bx ? 1 : 0;
}

function sanitizeMultisigPolicyName(raw: string): string {
	let name = raw.replace(/[^\x20-\x7e]/g, '').trim();
	if (name === '') name = 'Hearth multisig';
	if (name.length > 64) name = `${name.slice(0, 61).trim()}...`;
	return name;
}

function templateFor(scriptType: MultisigScriptTypeForPolicy, threshold: number, keyCount: number): string {
	const signers = Array.from({ length: keyCount }, (_, i) => `@${i}/**`).join(',');
	const inner = `sortedmulti(${threshold},${signers})`;
	if (scriptType === 'p2wsh') return `wsh(${inner})`;
	if (scriptType === 'p2sh') return `sh(${inner})`;
	return `sh(wsh(${inner}))`; // p2sh-p2wsh
}

/** Build the (unsorted-input, sorted-output) BIP-388 wallet policy from the
 *  wallet's cosigner roster. Validated entirely before any device touch. */
export function buildMultisigPolicy(
	keys: MultisigSignKey[],
	threshold: number,
	scriptType: MultisigScriptTypeForPolicy,
	name: string
): MultisigWalletPolicy {
	if (threshold < 1 || threshold > keys.length) {
		throw new LedgerError('That threshold is not valid for this wallet.', 'bad_psbt');
	}
	const keyStrs = keys.map((k) => {
		if (!/^[0-9a-fA-F]{8}$/.test(k.fingerprint)) {
			throw new LedgerError('One of this wallet’s keys has an invalid fingerprint.', 'bad_psbt');
		}
		const xpub = normalizeXpub(k.xpub);
		const pathIndexes = parseKeyPath(k.path, 'cosigner path', (m) => new LedgerError(m, 'bad_psbt'));
		const originStr = pathIndexes.length === 0 ? '' : `/${formatKeyPath(pathIndexes).slice(2)}`;
		return `[${k.fingerprint.toLowerCase()}${originStr}]${xpub}`;
	});
	keyStrs.sort(compareMultisigPolicyKeys);
	return {
		name: sanitizeMultisigPolicyName(name),
		template: templateFor(scriptType, threshold, keyStrs.length),
		keys: keyStrs
	};
}

/** Byte-identical serialization to `ledger-bitcoin`'s wallet-policy
 *  registration preimage: version byte 0x02, varint-prefixed name, the
 *  template committed as its SHA256 (not raw bytes), varint key count, and
 *  a Merkle root over `hashLeaf(ascii(key))` per key. */
function serializeMultisigPolicy(policy: MultisigWalletPolicy, deps: PolicyDeps): Buffer {
	const nameBytes = Buffer.from(policy.name, 'ascii');
	const templateBytes = Buffer.from(policy.template, 'ascii');
	const keysRoot = new deps.Merkle(policy.keys.map((k) => deps.hashLeaf(Buffer.from(k, 'ascii')))).getRoot();
	return Buffer.concat([
		Buffer.from([0x02]),
		deps.createVarint(nameBytes.length),
		nameBytes,
		deps.createVarint(templateBytes.length),
		Buffer.from(sha256(templateBytes)),
		deps.createVarint(policy.keys.length),
		keysRoot
	]);
}

interface PolicyDeps {
	Merkle: new (leaves: Buffer[]) => { getRoot(): Buffer };
	hashLeaf: (b: Buffer) => Buffer;
	createVarint: (n: number) => Buffer;
}

async function loadPolicyDeps(): Promise<PolicyDeps & { ClientCommandInterpreter: new (cb: () => void) => ClientCommandInterpreterLike }> {
	const [clientCommandsMod, varintMod, merkleMod] = await Promise.all([
		import('@ledgerhq/hw-app-btc/lib/newops/clientCommands.js'),
		import('@ledgerhq/hw-app-btc/lib/varint.js'),
		import('@ledgerhq/hw-app-btc/lib/newops/merkle.js')
	]);
	return {
		ClientCommandInterpreter: clientCommandsMod.ClientCommandInterpreter,
		createVarint: varintMod.createVarint,
		Merkle: merkleMod.Merkle,
		hashLeaf: merkleMod.hashLeaf
	};
}

interface ClientCommandInterpreterLike {
	addKnownPreimage(preimage: Buffer): void;
	addKnownList(elements: Buffer[]): void;
	execute(request: Buffer): Buffer;
}

/** A `WalletPolicy`-shaped object AppClient.signPsbt duck-types against
 *  (calls `.descriptorTemplate`, `.keys`, `.serialize()`, `.getWalletId()`,
 *  no `instanceof` check) -- carries our hand-built NAMED policy, since
 *  hw-app-btc's own `WalletPolicy` class hardcodes an empty name. */
class NamedWalletPolicy {
	readonly descriptorTemplate: string;
	readonly keys: string[];
	private readonly deps: PolicyDeps;
	private readonly name: string;
	constructor(policy: MultisigWalletPolicy, deps: PolicyDeps) {
		this.descriptorTemplate = policy.template;
		this.keys = policy.keys;
		this.name = policy.name;
		this.deps = deps;
	}
	serialize(): Buffer {
		return serializeMultisigPolicy({ name: this.name, template: this.descriptorTemplate, keys: this.keys }, this.deps);
	}
	getWalletId(): Buffer {
		return Buffer.from(sha256(this.serialize()));
	}
}

const CLA_BTC = 0xe1;
const CLA_FRAMEWORK = 0xf8;
const INS_REGISTER_WALLET = 0x02;
const INS_CONTINUE_INTERRUPTED = 0x01;
const APDU_PROTOCOL_VERSION = 1;
const SW_INTERRUPTED = 0xe000;

interface LedgerTransport {
	send(cla: number, ins: number, p1: number, p2: number, data?: Buffer, statusList?: number[]): Promise<Buffer>;
	close(): Promise<void>;
}

/** Same interrupt/continue loop shape as `AppClient`'s private `makeRequest`:
 *  first exchange uses CLA_BTC/the caller's ins; every continuation uses
 *  CLA_FRAMEWORK/INS_CONTINUE_INTERRUPTED with the interpreter's answer to
 *  the app's data request as the next exchange's payload. */
async function exchangeInterruptible(
	transport: LedgerTransport,
	ins: number,
	data: Buffer,
	interpreter: { execute(request: Buffer): Buffer }
): Promise<Buffer> {
	let response = await transport.send(CLA_BTC, ins, 0, APDU_PROTOCOL_VERSION, data, [0x9000, SW_INTERRUPTED]);
	while (response.readUInt16BE(response.length - 2) === SW_INTERRUPTED) {
		const hwRequest = response.subarray(0, response.length - 2);
		response = await transport.send(
			CLA_FRAMEWORK,
			INS_CONTINUE_INTERRUPTED,
			0,
			APDU_PROTOCOL_VERSION,
			interpreter.execute(hwRequest),
			[0x9000, SW_INTERRUPTED]
		);
	}
	return response.subarray(0, response.length - 2);
}

/** Which of this wallet's cosigner keys the connected device is. */
function assertDeviceIsMultisigCosigner(deviceFpHex: string, keys: MultisigSignKey[]): number {
	const index = keys.findIndex((k) => k.fingerprint.toLowerCase() === deviceFpHex);
	if (index === -1) {
		const roster = keys.map((k) => k.fingerprint).join(', ');
		throw new LedgerError(
			`This Ledger (fingerprint ${deviceFpHex}) isn't one of this wallet's cosigners (expects one of: ${roster}).`,
			'wrong_device'
		);
	}
	return index;
}

export interface LedgerRegistration {
	masterFp: string;
	policyId: string;
	policyHmac: string;
}

/** Register this wallet's BIP-388 policy with a connected Ledger (one-time
 *  per device). Returns the HMAC the caller persists server-side
 *  (`ledger_wallet_registrations`) so a later sign can skip re-approval. The
 *  HMAC is not secret -- it only suppresses re-registration. */
export async function registerMultisigPolicy(
	keys: MultisigSignKey[],
	threshold: number,
	scriptType: MultisigScriptTypeForPolicy,
	name: string
): Promise<LedgerRegistration> {
	if (!isWebHidAvailable()) {
		throw new LedgerError('Ledger connects over a secure browser channel that this browser/origin does not have.', 'unavailable');
	}
	const policy = buildMultisigPolicy(keys, threshold, scriptType, name);
	await ensureNodeGlobals();
	const [{ default: TransportWebHID }, { AppClient }, deps] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient.js'),
		loadPolicyDeps()
	]);

	let transport: Awaited<ReturnType<typeof TransportWebHID.create>> | undefined;
	try {
		transport = await withLedgerTimeout(TransportWebHID.create().catch((e: unknown) => { throw toLedgerError(e); }), 'connecting');
		const client = new AppClient(transport);
		const masterFp = await withLedgerTimeout(
			client.getMasterFingerprint().catch((e: unknown) => { throw toLedgerError(e); }),
			'reading the device fingerprint'
		);
		const fpHex = bytesToFpHex(masterFp);
		assertDeviceIsMultisigCosigner(fpHex, keys);

		const serialized = serializeMultisigPolicy(policy, deps);
		const interpreter = new deps.ClientCommandInterpreter(() => {});
		interpreter.addKnownPreimage(serialized);
		interpreter.addKnownList(policy.keys.map((k) => Buffer.from(k, 'ascii')));
		interpreter.addKnownPreimage(Buffer.from(policy.template, 'ascii'));

		const response = await withLedgerTimeout(
			exchangeInterruptible(
				transport as unknown as LedgerTransport,
				INS_REGISTER_WALLET,
				Buffer.concat([deps.createVarint(serialized.length), serialized]),
				interpreter
			).catch((e: unknown) => { throw toLedgerError(e); }),
			'registering the wallet'
		);
		if (response.length !== 64) {
			throw new LedgerError('The Ledger returned an unexpected registration response.', 'unexpected');
		}
		return {
			masterFp: fpHex,
			policyId: response.subarray(0, 32).toString('hex'),
			policyHmac: response.subarray(32, 64).toString('hex')
		};
	} finally {
		await transport?.close().catch(() => {});
	}
}

/** Derive this device's expected per-input pubkey by extending its account
 *  xpub by each input's (chain,index) suffix read from `bip32Derivation`,
 *  cross-checking every derived pubkey is actually declared in that input. */
async function multisigDevicePubkeys(
	tx: btc.Transaction,
	accountXpub: string
): Promise<Uint8Array[]> {
	const { HDKey } = await import('@scure/bip32');
	const node = HDKey.fromExtendedKey(normalizeXpub(accountXpub));
	const out: Uint8Array[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		const derivations = input.bip32Derivation ?? [];
		const path = derivations[0]?.[1]?.path;
		if (!path || path.length < 2) {
			throw new LedgerError(`Input ${i} is missing the key-origin information this signer needs.`, 'bad_psbt');
		}
		const [chain, index] = path.slice(-2);
		const child = node.deriveChild(chain).deriveChild(index);
		if (!child.publicKey) throw new LedgerError('Could not derive this device’s key for one of the inputs.', 'unexpected');
		const declared = derivations.some(([pk]) => buffersEqual(Uint8Array.from(pk), child.publicKey as Uint8Array));
		if (!declared) {
			throw new LedgerError(`Input ${i} doesn't declare this device's derived key -- refusing to sign.`, 'bad_psbt');
		}
		out.push(child.publicKey);
	}
	return out;
}

/** Merge multisig signatures back. Ledger's multisig sigs arrive WITH their
 *  sighash byte already appended (unlike Trezor) -- merged verbatim. */
function mergeMultisigSignatures(tx: btc.Transaction, sigs: Map<number, Uint8Array | Buffer>, devicePubkeys: Uint8Array[]): void {
	if (devicePubkeys.length !== tx.inputsLength) {
		throw new LedgerError('Internal error matching signatures to inputs.', 'unexpected');
	}
	if (sigs.size === 0) throw new LedgerError('The Ledger returned no signatures.', 'unexpected');
	sigs.forEach((sig, index) => {
		if (index < 0 || index >= tx.inputsLength) throw new LedgerError('Signature for an unknown input.', 'unexpected');
		const sigBytes = toU8(sig as Uint8Array);
		if (sigBytes.length === 0) throw new LedgerError(`Empty signature for input ${index}.`, 'unexpected');
		const pubkey = devicePubkeys[index];
		const input = tx.getInput(index);
		const derivations = input.bip32Derivation ?? [];
		const declared = derivations.some(([pk]) => buffersEqual(Uint8Array.from(pk), pubkey));
		if (!declared) throw new LedgerError(`Input ${index}'s key isn't declared for this wallet.`, 'unexpected');
		tx.updateInput(index, { partialSig: [[pubkey, sigBytes]] });
	});
}

/** Sign a multisig PSBT with a connected, ALREADY-REGISTERED Ledger.
 *  `policyHmac` must be the HMAC returned by a prior `registerMultisigPolicy`
 *  call for this wallet + this device. */
export async function signMultisigPsbtWithLedger(
	unsignedPsbtBase64: string,
	keys: MultisigSignKey[],
	threshold: number,
	scriptType: MultisigScriptTypeForPolicy,
	name: string,
	policyHmac: string | null
): Promise<string> {
	if (!isWebHidAvailable()) {
		throw new LedgerError('Ledger connects over a secure browser channel that this browser/origin does not have.', 'unavailable');
	}
	if (!policyHmac) {
		throw new LedgerError('This wallet needs to be registered with the Ledger before signing.', 'policy_unregistered');
	}
	const policy = buildMultisigPolicy(keys, threshold, scriptType, name);
	const sourceTx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));

	await ensureNodeGlobals();
	const [{ default: TransportWebHID }, { AppClient }, { PsbtV2 }, deps] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient.js'),
		import('@ledgerhq/psbtv2'),
		loadPolicyDeps()
	]);

	let transport: Awaited<ReturnType<typeof TransportWebHID.create>> | undefined;
	try {
		transport = await withLedgerTimeout(TransportWebHID.create().catch((e: unknown) => { throw toLedgerError(e); }), 'connecting');
		const client = new AppClient(transport);
		const masterFp = await withLedgerTimeout(
			client.getMasterFingerprint().catch((e: unknown) => { throw toLedgerError(e); }),
			'reading the device fingerprint'
		);
		const fpHex = bytesToFpHex(masterFp);
		const keyIndex = assertDeviceIsMultisigCosigner(fpHex, keys);
		const accountXpub = normalizeXpub(keys[keyIndex].xpub);
		const devicePubkeys = await multisigDevicePubkeys(sourceTx, accountXpub);

		const device = new NamedWalletPolicy(policy, deps);
		const psbtV2 = PsbtV2.fromV0(Buffer.from(sourceTx.toPSBT()));
		// PsbtV2.fromV0 does not copy PSBT_IN_WITNESS_SCRIPT (0x05). The app
		// derives the script from the registered policy itself, so signing
		// works without it -- carried across anyway (spec-correct, harmless)
		// via the library's private generic setter, feature-detected.
		const rawPsbt = psbtV2 as unknown as { setInput?: (index: number, keyType: number, keyData: Buffer, value: Buffer) => void };
		if (typeof rawPsbt.setInput === 'function') {
			for (let i = 0; i < sourceTx.inputsLength; i++) {
				const ws = sourceTx.getInput(i).witnessScript;
				if (ws) rawPsbt.setInput(i, 0x05, Buffer.alloc(0), Buffer.from(ws));
			}
		}

		const hmacBuf = Buffer.from(policyHmac, 'hex');
		const sigs = await withLedgerTimeout(
			client.signPsbt(psbtV2, device, hmacBuf, () => {}).catch((e: unknown) => { throw toLedgerError(e); }),
			'signing the transaction'
		);
		mergeMultisigSignatures(sourceTx, sigs, devicePubkeys);
		return base64.encode(sourceTx.toPSBT());
	} finally {
		await transport?.close().catch(() => {});
	}
}
