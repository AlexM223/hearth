/**
 * The ScriptEngine seam (WALLET-ENGINE §0.2, §3.1) -- the ONLY place `kind` is
 * read. Every layer above (storage, scan, coin-selection, review, commitment-
 * check, reservation, broadcast, routes) depends on this interface, never on
 * the concrete kind. `selectEngine(wallet)` is the single kind switch in the
 * whole engine.
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import type { SigningProgress, SpendableUtxo, Wallet } from '../types.js';
import { InvalidPsbtError, NotFullySignedError } from '../errors.js';
import { SingleSigEngine } from './single.js';
import { MultisigEngine } from './multisig.js';

export interface DerivedScript {
	address: string;
	scriptPubKey: Uint8Array;
	witnessScript?: Uint8Array; // multisig / wrapped only
	redeemScript?: Uint8Array; // p2sh-wrapped only
}

/** bip32 derivation entry in @scure/btc-signer shape: [pubkey, {fingerprint: u32, path}]. */
export type Bip32Derivation = [Uint8Array, { fingerprint: number; path: number[] }];

export interface PsbtInputMeta {
	witnessUtxo?: { script: Uint8Array; amount: bigint };
	nonWitnessUtxo?: Uint8Array; // legacy p2pkh / bare p2sh; anti-fee-lying
	redeemScript?: Uint8Array;
	witnessScript?: Uint8Array;
	bip32Derivation: Bip32Derivation[]; // 1 (single) or N (multisig)
	sequence: number;
}

export interface ChangeMeta {
	bip32Derivation: Bip32Derivation[];
	redeemScript?: Uint8Array;
	witnessScript?: Uint8Array;
}

export interface ScriptEngine {
	readonly kind: 'single' | 'multisig';
	readonly network: 'mainnet' | 'testnet' | 'regtest';
	/** Address + scripts for (chain, index). Multisig BIP-67-sorts per address. */
	scriptFor(chain: 0 | 1, index: number): DerivedScript;
	/** Per-input PSBT fields for a coin. rawPrevTx supplies nonWitnessUtxo when needed. */
	inputMeta(utxo: SpendableUtxo, rawPrevTx?: Uint8Array): PsbtInputMeta;
	/** Change-output PSBT fields so a signer recognizes change paying back to us. */
	changeMeta(index: number): ChangeMeta;
	/** vsize contribution of one input of this wallet's script type. */
	perInputVsize(): number;
	/** M-of-N signing state, always re-derived from the PSBT bytes (never stored). */
	signingProgress(psbtBase64: string): SigningProgress;
	/** Finalize a fully-signed PSBT to raw wire bytes + deterministic local txid. */
	finalize(psbtBase64: string): { rawHex: string; txid: string };
	/** Merge an incoming partially-signed PSBT (multisig only). */
	combine?(baseBase64: string, incomingBase64: string): string;
}

/** THE only kind switch in the engine (WALLET-ENGINE §0.2, §3.1). */
export function selectEngine(wallet: Wallet): ScriptEngine {
	return wallet.kind === 'multisig' ? new MultisigEngine(wallet) : new SingleSigEngine(wallet);
}

// ------------------------------------------------------ shared PSBT utilities
// Kind-blind helpers used by both concrete engines. Not exported from index.

/** Decode a base64 PSBT to a scure Transaction, mapping every failure to a
 *  clean typed InvalidPsbtError (no stack, no buffer dump). Guards against a
 *  pathological huge payload by bounding the decoded size. */
export function parsePsbt(psbtBase64: string): btc.Transaction {
	if (typeof psbtBase64 !== 'string' || psbtBase64.length === 0) {
		throw new InvalidPsbtError('empty PSBT');
	}
	// A legitimate wallet PSBT is well under a few hundred KB; a multi-MB payload
	// is hostile. Bound the base64 length so decode/parse can't be made to hang.
	if (psbtBase64.length > 4_000_000) {
		throw new InvalidPsbtError('PSBT payload is implausibly large and was refused');
	}
	let bytes: Uint8Array;
	try {
		bytes = base64.decode(psbtBase64.trim());
	} catch {
		throw new InvalidPsbtError('PSBT is not valid base64');
	}
	// PSBT magic: 0x70 0x73 0x62 0x74 0xff ("psbt" + 0xff).
	if (bytes.length < 5 || bytes[0] !== 0x70 || bytes[1] !== 0x73 || bytes[2] !== 0x62 || bytes[3] !== 0x74 || bytes[4] !== 0xff) {
		throw new InvalidPsbtError('PSBT magic bytes are missing or corrupt');
	}
	try {
		return btc.Transaction.fromPSBT(bytes);
	} catch (e) {
		throw new InvalidPsbtError('PSBT could not be parsed: ' + shortReason(e));
	}
}

/** Serialize a scure Transaction (working PSBT) back to base64. */
export function psbtToBase64(tx: btc.Transaction): string {
	return base64.encode(tx.toPSBT());
}

/** Finalize helper shared by both engines' finalize() (after any kind-specific
 *  quorum gate). Maps scure's finalize/extract failures to NotFullySignedError. */
export function finalizeTx(tx: btc.Transaction): { rawHex: string; txid: string } {
	try {
		tx.finalize();
	} catch (e) {
		throw new NotFullySignedError('cannot finalize: ' + shortReason(e));
	}
	let rawHex: string;
	try {
		rawHex = tx.hex;
	} catch (e) {
		throw new NotFullySignedError('cannot extract final transaction: ' + shortReason(e));
	}
	return { rawHex, txid: tx.id };
}

/** Parse a key-origin path string ("m/84'/0'/0'") to a hardened-aware number[]. */
export function parseHdPath(path: string): number[] {
	const clean = path.trim().replace(/^m\//i, '').replace(/^m$/i, '');
	if (clean === '') return [];
	const HARDENED = 0x80000000;
	return clean.split('/').map((seg) => {
		const hardened = seg.endsWith("'") || seg.endsWith('h') || seg.endsWith('H');
		const n = parseInt(hardened ? seg.slice(0, -1) : seg, 10);
		if (!Number.isInteger(n) || n < 0) throw new Error(`invalid path segment: ${seg}`);
		return hardened ? (n + HARDENED) >>> 0 : n >>> 0;
	});
}

/** 8-hex master fingerprint -> the uint32 @scure/btc-signer expects (big-endian). */
export function fingerprintToU32(fpHex: string): number {
	const clean = /^[0-9a-fA-F]{8}$/.test(fpHex) ? fpHex : '00000000';
	return parseInt(clean, 16) >>> 0;
}

/** Extract a compact one-line reason from an unknown thrown value (no stack). */
export function shortReason(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.split('\n')[0].slice(0, 200);
}

/** Order-sensitive canonical key for a parsed PSBT's inputs (outpoint list). */
export function inputsIdentity(tx: btc.Transaction): string {
	const parts: string[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		const txid = inp.txid ? base16(inp.txid) : '';
		parts.push(`${txid}:${inp.index ?? ''}`);
	}
	return parts.join(',');
}

/** Order-sensitive canonical key for a parsed PSBT's outputs (script:amount list). */
export function outputsIdentity(tx: btc.Transaction): string {
	const parts: string[] = [];
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i) as { script?: Uint8Array; amount?: bigint };
		const script = out.script ? base16(out.script) : '';
		parts.push(`${script}:${out.amount ?? ''}`);
	}
	return parts.join(',');
}

/** Do two parsed PSBTs describe the SAME transaction (same inputs + outputs,
 *  order-sensitive)? Signing never changes these fields, so a difference is
 *  tampering / a different tx (WALLET-ENGINE §4.9 invariant 2, §5.2). */
export function samePsbtIdentity(a: btc.Transaction, b: btc.Transaction): boolean {
	return (
		a.inputsLength === b.inputsLength &&
		a.outputsLength === b.outputsLength &&
		inputsIdentity(a) === inputsIdentity(b) &&
		outputsIdentity(a) === outputsIdentity(b)
	);
}

function base16(u8: Uint8Array): string {
	let s = '';
	for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
	return s;
}
