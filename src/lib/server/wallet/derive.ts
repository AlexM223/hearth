/**
 * ECC-free HD derivation + address/script encoding (WALLET-ENGINE §4.1).
 *
 * "ECC-free" here means the no-native-addon sense (DECISIONS.md §2): no
 * tiny-secp256k1/secp256k1 native module. Public-key child derivation is pure
 * JS via @scure/bip32 (which uses @noble/curves, pure JS); address encoding is
 * @scure/base (bech32/base58check) + @noble/hashes (sha256/ripemd160). The
 * server NEVER derives a private key or holds key material (§5.1) -- it parses
 * xpubs, derives the public side, and encodes scripts.
 *
 * SLIP-132 version bytes (ypub/zpub/...) select the script type and are
 * normalized to standard xpub/tpub before HDKey parse. Private extended keys
 * are rejected BEFORE any other processing and the secret is never echoed.
 */
import { HDKey } from '@scure/bip32';
import { base58, base58check, bech32, bech32m, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import type { ChainNetwork, ScriptType, SingleScriptType } from './types.js';

const b58check = base58check(sha256);

// -------------------------------------------------------------- network params

export interface NetworkParams {
	network: ChainNetwork;
	bech32Hrp: string;
	pubKeyHash: number;
	scriptHash: number;
	/** Standard BIP-32 public version bytes for this network (for SLIP-132 normalize). */
	xpubVersion: number;
}

const MAINNET: NetworkParams = {
	network: 'mainnet',
	bech32Hrp: 'bc',
	pubKeyHash: 0x00,
	scriptHash: 0x05,
	xpubVersion: 0x0488b21e
};
const TESTNET: NetworkParams = {
	network: 'testnet',
	bech32Hrp: 'tb',
	pubKeyHash: 0x6f,
	scriptHash: 0xc4,
	xpubVersion: 0x043587cf
};
const REGTEST: NetworkParams = {
	network: 'regtest',
	bech32Hrp: 'bcrt',
	pubKeyHash: 0x6f,
	scriptHash: 0xc4,
	xpubVersion: 0x043587cf
};

export function networkParams(network: ChainNetwork): NetworkParams {
	return network === 'mainnet' ? MAINNET : network === 'testnet' ? TESTNET : REGTEST;
}

// ------------------------------------------------------------- SLIP-132 table

interface VersionInfo {
	scriptType: SingleScriptType;
	network: ChainNetwork;
	isPrivate: boolean;
}

// Public + private SLIP-132 version bytes. Private ones exist ONLY so we can
// reject them loudly (never parse); we never emit a private key.
const VERSION_TABLE: Record<number, VersionInfo> = {
	0x0488b21e: { scriptType: 'p2pkh', network: 'mainnet', isPrivate: false }, // xpub
	0x0488ade4: { scriptType: 'p2pkh', network: 'mainnet', isPrivate: true }, // xprv
	0x049d7cb2: { scriptType: 'p2sh-p2wpkh', network: 'mainnet', isPrivate: false }, // ypub
	0x049d7878: { scriptType: 'p2sh-p2wpkh', network: 'mainnet', isPrivate: true }, // yprv
	0x04b24746: { scriptType: 'p2wpkh', network: 'mainnet', isPrivate: false }, // zpub
	0x04b2430c: { scriptType: 'p2wpkh', network: 'mainnet', isPrivate: true }, // zprv
	0x043587cf: { scriptType: 'p2pkh', network: 'testnet', isPrivate: false }, // tpub
	0x04358394: { scriptType: 'p2pkh', network: 'testnet', isPrivate: true }, // tprv
	0x044a5262: { scriptType: 'p2sh-p2wpkh', network: 'testnet', isPrivate: false }, // upub
	0x044a4e28: { scriptType: 'p2sh-p2wpkh', network: 'testnet', isPrivate: true }, // uprv
	0x045f1cf6: { scriptType: 'p2wpkh', network: 'testnet', isPrivate: false }, // vpub
	0x045f18bc: { scriptType: 'p2wpkh', network: 'testnet', isPrivate: true } // vprv
};

export class PrivateKeyRejectedError extends Error {
	constructor() {
		// NEVER include the key material in the message (WALLET-ENGINE §6.1 xpub suite).
		super('a private extended key (xprv/yprv/zprv/...) was supplied; import a PUBLIC key (xpub) only');
		this.name = 'PrivateKeyRejectedError';
	}
}

export class InvalidKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidKeyError';
	}
}

export interface ParsedXpub {
	hdkey: HDKey;
	/** Normalized standard-version xpub/tpub string. */
	normalizedXpub: string;
	/** Script type inferred from SLIP-132 version bytes (single-sig only). */
	inferredScriptType: SingleScriptType;
	network: ChainNetwork;
	/** The xpub's own fingerprint (hash160(pubkey)[:4]) -- a fallback origin fp. */
	selfFingerprint: string;
}

/**
 * Parse & normalize an extended PUBLIC key. Rejects private keys first, never
 * echoing the secret. Returns the parsed HDKey plus inferred script type/network.
 */
export function parseXpub(raw: string): ParsedXpub {
	const trimmed = raw.trim();
	if (!trimmed) throw new InvalidKeyError('empty extended key');

	let decoded: Uint8Array;
	try {
		decoded = base58.decode(trimmed);
	} catch {
		throw new InvalidKeyError('not a valid base58 extended key');
	}
	// base58check with a 4-byte checksum; the payload is 78 bytes.
	if (decoded.length !== 82) {
		throw new InvalidKeyError('extended key has the wrong length');
	}
	let payload: Uint8Array;
	try {
		payload = b58check.decode(trimmed);
	} catch {
		throw new InvalidKeyError('extended-key checksum failed');
	}
	if (payload.length !== 78) throw new InvalidKeyError('extended key has the wrong length');

	const version =
		(payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
	const versionU = version >>> 0;
	const info = VERSION_TABLE[versionU];

	// Reject private keys BEFORE anything else: either a known *prv version, or
	// the 33-byte key field beginning with 0x00 (private-key serialization).
	const keyFieldFirst = payload[45];
	if ((info && info.isPrivate) || keyFieldFirst === 0x00) {
		throw new PrivateKeyRejectedError();
	}
	if (!info) {
		throw new InvalidKeyError('unrecognized extended-key version bytes');
	}

	const net = networkParams(info.network);
	// Normalize SLIP-132 -> standard xpub/tpub so HDKey parses it.
	const normalized = new Uint8Array(payload);
	normalized[0] = (net.xpubVersion >>> 24) & 0xff;
	normalized[1] = (net.xpubVersion >>> 16) & 0xff;
	normalized[2] = (net.xpubVersion >>> 8) & 0xff;
	normalized[3] = net.xpubVersion & 0xff;
	const normalizedXpub = b58check.encode(normalized);

	let hdkey: HDKey;
	try {
		hdkey = HDKey.fromExtendedKey(normalizedXpub);
	} catch {
		throw new InvalidKeyError('extended key could not be parsed');
	}
	if (hdkey.privateKey) {
		// Defense in depth -- should be impossible after the checks above.
		throw new PrivateKeyRejectedError();
	}
	if (!hdkey.publicKey) throw new InvalidKeyError('extended key has no public key');

	return {
		hdkey,
		normalizedXpub,
		inferredScriptType: info.scriptType,
		network: info.network,
		selfFingerprint: fingerprintHex(hash160(hdkey.publicKey))
	};
}

// -------------------------------------------------------------------- hashing

export function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

/** 8-lowercase-hex fingerprint from a 20-byte hash160 (first 4 bytes). */
export function fingerprintHex(h160: Uint8Array): string {
	return hex.encode(h160.slice(0, 4));
}

/** Electrum scripthash: sha256(scriptPubKey), byte-reversed, hex. */
export function scriptToScripthash(scriptPubKey: Uint8Array): string {
	const h = sha256(scriptPubKey);
	return hex.encode(h.slice().reverse());
}

// ------------------------------------------------------ scriptPubKey builders

const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_EQUAL = 0x87;

/** p2pkh scriptPubKey: OP_DUP OP_HASH160 <20> h160 OP_EQUALVERIFY OP_CHECKSIG. */
export function p2pkhScript(h160: Uint8Array): Uint8Array {
	return Uint8Array.from([OP_DUP, OP_HASH160, 0x14, ...h160, OP_EQUALVERIFY, OP_CHECKSIG]);
}

/** p2sh scriptPubKey: OP_HASH160 <20> scriptHash OP_EQUAL. */
export function p2shScript(scriptH160: Uint8Array): Uint8Array {
	return Uint8Array.from([OP_HASH160, 0x14, ...scriptH160, OP_EQUAL]);
}

/** v0 witness program scriptPubKey: OP_0 <len> program (20 = p2wpkh, 32 = p2wsh). */
export function witnessV0Script(program: Uint8Array): Uint8Array {
	return Uint8Array.from([0x00, program.length, ...program]);
}

// ------------------------------------------------------------- address encode

export function encodeP2pkh(h160: Uint8Array, net: NetworkParams): string {
	return b58check.encode(Uint8Array.from([net.pubKeyHash, ...h160]));
}

export function encodeP2sh(scriptH160: Uint8Array, net: NetworkParams): string {
	return b58check.encode(Uint8Array.from([net.scriptHash, ...scriptH160]));
}

/** Segwit v0 bech32 address for a 20- (p2wpkh) or 32-byte (p2wsh) program. */
export function encodeSegwitV0(program: Uint8Array, net: NetworkParams): string {
	return bech32.encode(net.bech32Hrp, [0, ...bech32.toWords(program)]);
}

/** Segwit v1+ (taproot) uses bech32m -- included for recipient encoding only. */
export function encodeSegwitVn(version: number, program: Uint8Array, net: NetworkParams): string {
	return bech32m.encode(net.bech32Hrp, [version, ...bech32m.toWords(program)]);
}
