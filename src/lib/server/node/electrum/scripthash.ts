/**
 * Bitcoin address -> Electrum scripthash (BIP: `sha256(scriptPubKey)`,
 * byte-reversed, hex -- see electrum-protocol.readthedocs.io). Self-contained
 * (no @scure/* dependency): those land with the wallet engine in M2
 * (DECISIONS.md §2). This is intentionally minimal -- just enough address
 * decoding (base58check + bech32/bech32m) to build a scriptPubKey and derive
 * its scripthash, for the M1 QA harness and Home's own-address checks.
 * Mainnet only for now; M2 adds testnet/regtest prefixes alongside the real
 * wallet engine.
 */
import { createHash } from 'node:crypto';

function sha256(data: Uint8Array): Buffer {
	return createHash('sha256').update(data).digest();
}

// ---------------------------------------------------------------- base58check

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(Array.from(BASE58_ALPHABET).map((c, i) => [c, i]));

function base58Decode(input: string): Buffer {
	let num = 0n;
	for (const ch of input) {
		const val = BASE58_MAP.get(ch);
		if (val === undefined) throw new Error(`invalid base58 character: ${ch}`);
		num = num * 58n + BigInt(val);
	}
	let bytes: number[] = [];
	while (num > 0n) {
		bytes.unshift(Number(num & 0xffn));
		num >>= 8n;
	}
	// Leading '1's encode leading zero bytes.
	for (const ch of input) {
		if (ch !== '1') break;
		bytes.unshift(0);
	}
	return Buffer.from(bytes);
}

/** Decodes base58check, verifying the trailing 4-byte checksum. Returns { version, payload }. */
function base58CheckDecode(input: string): { version: number; payload: Buffer } {
	const full = base58Decode(input);
	if (full.length < 5) throw new Error('base58check payload too short');
	const body = full.subarray(0, full.length - 4);
	const checksum = full.subarray(full.length - 4);
	const expected = sha256(sha256(body)).subarray(0, 4);
	if (!checksum.equals(expected)) throw new Error('base58check checksum mismatch');
	return { version: body[0], payload: body.subarray(1) };
}

// -------------------------------------------------------------- bech32/bech32m

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
	let chk = 1;
	for (const v of values) {
		const top = chk >>> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ v;
		for (let i = 0; i < 5; i++) {
			if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
		}
	}
	return chk;
}

function bech32HrpExpand(hrp: string): number[] {
	const out: number[] = [];
	for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
	out.push(0);
	for (const c of hrp) out.push(c.charCodeAt(0) & 31);
	return out;
}

function bech32VerifyChecksum(hrp: string, data: number[], constOverride: number): boolean {
	return bech32Polymod(bech32HrpExpand(hrp).concat(data)) === constOverride;
}

/** Decodes a bech32/bech32m address (BIP173/BIP350). Returns { hrp, version, program }. */
function bech32Decode(address: string): { hrp: string; version: number; program: Buffer } {
	const lower = address.toLowerCase();
	if (address !== lower && address !== address.toUpperCase()) {
		throw new Error('bech32: mixed case');
	}
	const pos = lower.lastIndexOf('1');
	if (pos < 1 || pos + 7 > lower.length) throw new Error('bech32: invalid separator position');
	const hrp = lower.slice(0, pos);
	const dataPart = lower.slice(pos + 1);
	const data: number[] = [];
	for (const c of dataPart) {
		const v = BECH32_CHARSET.indexOf(c);
		if (v === -1) throw new Error(`bech32: invalid character ${c}`);
		data.push(v);
	}
	const BECH32_CONST = 1;
	const BECH32M_CONST = 0x2bc830a3;
	const isBech32 = bech32VerifyChecksum(hrp, data, BECH32_CONST);
	const isBech32m = !isBech32 && bech32VerifyChecksum(hrp, data, BECH32M_CONST);
	if (!isBech32 && !isBech32m) throw new Error('bech32: checksum mismatch');

	const version = data[0];
	if (isBech32 && version !== 0) throw new Error('bech32: v0 requires bech32, not bech32m');
	if (isBech32m && version === 0) throw new Error('bech32m: v0 requires bech32, not bech32m');

	const words = data.slice(1, data.length - 6); // strip version + 6-word checksum
	const program = convertBits(words, 5, 8, false);
	if (!program || program.length < 2 || program.length > 40) {
		throw new Error('bech32: invalid program length');
	}
	return { hrp, version, program: Buffer.from(program) };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
	let acc = 0;
	let bits = 0;
	const out: number[] = [];
	const maxv = (1 << to) - 1;
	for (const value of data) {
		if (value < 0 || value >> from !== 0) return null;
		acc = (acc << from) | value;
		bits += from;
		while (bits >= to) {
			bits -= to;
			out.push((acc >> bits) & maxv);
		}
	}
	if (pad) {
		if (bits > 0) out.push((acc << (to - bits)) & maxv);
	} else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
		return null;
	}
	return out;
}

// ---------------------------------------------------------------- scriptPubKey

const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_EQUAL = 0x87;

/** Builds the raw scriptPubKey bytes for a mainnet address (P2PKH/P2SH/P2WPKH/P2WSH/P2TR). */
export function addressToScriptPubKey(address: string): Buffer {
	// Bech32/bech32m: bc1... (mainnet).
	if (address.toLowerCase().startsWith('bc1')) {
		const { version, program } = bech32Decode(address);
		const opN = version === 0 ? 0x00 : 0x50 + version; // OP_0, OP_1..OP_16
		return Buffer.concat([Buffer.from([opN, program.length]), program]);
	}
	// Base58check: P2PKH (version 0x00) or P2SH (version 0x05), mainnet.
	const { version, payload } = base58CheckDecode(address);
	if (version === 0x00) {
		if (payload.length !== 20) throw new Error('P2PKH: hash160 must be 20 bytes');
		return Buffer.concat([
			Buffer.from([OP_DUP, OP_HASH160, payload.length]),
			payload,
			Buffer.from([OP_EQUALVERIFY, OP_CHECKSIG])
		]);
	}
	if (version === 0x05) {
		if (payload.length !== 20) throw new Error('P2SH: hash160 must be 20 bytes');
		return Buffer.concat([Buffer.from([OP_HASH160, payload.length]), payload, Buffer.from([OP_EQUAL])]);
	}
	throw new Error(`unsupported address version/format: ${address}`);
}

/**
 * Electrum scripthash for an address: sha256(scriptPubKey), byte-reversed, hex
 * -- the key `blockchain.scripthash.*` methods index by.
 */
export function addressToScriptHash(address: string): string {
	const script = addressToScriptPubKey(address);
	const hash = sha256(script);
	return Buffer.from(hash).reverse().toString('hex');
}
