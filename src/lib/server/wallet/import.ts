/**
 * Wallet import (WALLET-ENGINE §2.2): descriptor OR xpub (single-sig) OR
 * cosigners[] (multisig) -- all through ONE path. kind/scriptType are DERIVED
 * from the input, then stored as data; the caller never picks a code path.
 * Private extended keys are rejected FIRST (parseXpub) and never echoed.
 *
 * Descriptor checksum (hearth-624.12, Core-identical BIP-380): a descriptor
 * WITHOUT a `#checksum` is accepted as-is (Core/Sparrow compat; the checksum
 * is typo-detection, not a security boundary) and is separately re-validated
 * STRUCTURALLY (xpub base58check, key-origin depth cross-check). A descriptor
 * WITH a `#checksum` has that checksum VALIDATED against the exact BIP-380
 * algorithm; a mismatch is rejected with a warm error naming the checksum the
 * payload actually hashes to (typo help). Every descriptor Hearth emits
 * (buildDescriptor / walletToDescriptor) carries a freshly computed checksum.
 */
import { HDKey } from '@scure/bip32';
import type {
	ChainNetwork,
	MultisigScriptType,
	ScriptType,
	SingleScriptType,
	Wallet
} from './types.js';
import { parseXpub, InvalidKeyError } from './derive.js';
import { WalletError } from './errors.js';
import {
	deleteWalletRow,
	getWalletRow,
	insertWallet,
	listWalletRows,
	type NewWallet
} from './repo.js';
import { parseHdPath } from './script/engine.js';
import { addDescriptorChecksum, computeDescriptorChecksum, splitDescriptorChecksum } from './descsum.js';

class ImportError extends WalletError {
	constructor(message: string) {
		super(message);
		this.name = 'ImportError';
	}
}

interface ParsedKey {
	xpub: string; // normalized standard-version xpub/tpub
	fingerprint: string; // 8 lowercase hex; '00000000' if unknown
	path: string; // key-origin account path
}

interface ParsedDescriptor {
	kind: 'single' | 'multisig';
	scriptType: ScriptType;
	network: ChainNetwork;
	threshold: number;
	keys: ParsedKey[];
}

// --------------------------------------------------------- descriptor parsing

/** Strip a trailing `#checksum`, VALIDATING it (BIP-380, Core-identical) when
 *  present. A checksum-less descriptor is accepted unchanged (Core/Sparrow
 *  compat -- see module doc comment). A present-but-wrong checksum throws a
 *  warm, plain-language error naming the checksum the payload actually
 *  produces, so a typo is easy to fix. */
function stripChecksum(desc: string): string {
	const { payload, checksum } = splitDescriptorChecksum(desc);
	if (checksum === null) return payload;
	let expected: string;
	try {
		expected = computeDescriptorChecksum(payload);
	} catch {
		// Payload has a character outside the BIP-380 charset -- let downstream
		// parsing produce its own (more specific) error.
		return payload;
	}
	if (checksum !== expected) {
		throw new ImportError(
			`descriptor checksum "#${checksum}" doesn't match -- did you mean "#${expected}"? ` +
				`(check for a typo in the descriptor, or drop the checksum entirely)`
		);
	}
	return payload;
}

/** Parse one KEY expression: `[fp/origin]xpub[/suffix]`. Cross-checks the xpub's
 *  own depth/childNumber against the claimed origin path (Heartwood gap fix,
 *  §6.1) so a mismatched or mis-pasted xpub is rejected, not trusted. */
function parseKeyExpr(expr: string, defaultPath: string): ParsedKey {
	let rest = expr.trim();
	let fingerprint = '00000000';
	let originPath = defaultPath;

	if (rest.startsWith('[')) {
		const end = rest.indexOf(']');
		if (end < 0) throw new ImportError('malformed key origin (missing "]")');
		const origin = rest.slice(1, end); // e.g. "73c5da0a/84h/0h/0h"
		rest = rest.slice(end + 1);
		const slash = origin.indexOf('/');
		const fpPart = slash >= 0 ? origin.slice(0, slash) : origin;
		if (!/^[0-9a-fA-F]{8}$/.test(fpPart)) {
			throw new ImportError('key-origin fingerprint must be 8 hex characters');
		}
		fingerprint = fpPart.toLowerCase();
		originPath = slash >= 0 ? 'm/' + origin.slice(slash + 1) : defaultPath;
	}

	// The remaining is the xpub then an optional derivation suffix (/0/*, /<0;1>/*).
	const suffixSlash = rest.indexOf('/');
	const xpubStr = suffixSlash >= 0 ? rest.slice(0, suffixSlash) : rest;
	const parsed = parseXpub(xpubStr); // rejects private keys FIRST, never echoes

	// Cross-check: an account xpub's depth must equal the origin path length and
	// its childNumber must equal the last (hardened) origin segment.
	if (fingerprint !== '00000000') {
		const segs = parseHdPath(originPath);
		const hd = parsed.hdkey;
		if (hd.depth !== segs.length) {
			throw new ImportError(
				`key-origin path depth (${segs.length}) does not match the xpub depth (${hd.depth})`
			);
		}
		if (segs.length > 0 && (hd.index >>> 0) !== (segs[segs.length - 1] >>> 0)) {
			throw new ImportError('key-origin final index does not match the xpub');
		}
	}

	return { xpub: parsed.normalizedXpub, fingerprint, path: normalizePathDisplay(originPath) };
}

/** Normalize a path to the ' hardened form for stable storage/display. */
function normalizePathDisplay(path: string): string {
	const segs = path.trim().replace(/^m\//i, '').replace(/^m$/i, '');
	if (segs === '') return 'm';
	return (
		'm/' +
		segs
			.split('/')
			.map((s) => (s.endsWith('h') || s.endsWith('H') ? s.slice(0, -1) + "'" : s))
			.join('/')
	);
}

/** Split the comma-separated arguments of a function body, respecting brackets. */
function splitArgs(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of body) {
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			out.push(cur);
			cur = '';
		} else cur += ch;
	}
	if (cur.trim() !== '') out.push(cur);
	return out;
}

function unwrap(desc: string, fn: string): string | null {
	const prefix = fn + '(';
	if (desc.startsWith(prefix) && desc.endsWith(')')) {
		return desc.slice(prefix.length, -1);
	}
	return null;
}

function parseMulti(
	body: string,
	scriptType: MultisigScriptType,
	defaultPath: string
): ParsedDescriptor {
	const args = splitArgs(body);
	const threshold = parseInt(args[0].trim(), 10);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new ImportError('multisig threshold must be a positive integer');
	}
	const keyExprs = args.slice(1);
	if (keyExprs.length < threshold) {
		throw new ImportError('multisig has fewer keys than its threshold');
	}
	if (keyExprs.length < 2) throw new ImportError('multisig needs at least 2 cosigner keys');
	const keys = keyExprs.map((e) => parseKeyExpr(e, defaultPath));
	const network = inferNetwork(keys);
	return { kind: 'multisig', scriptType, network, threshold, keys };
}

function inferNetwork(keys: ParsedKey[]): ChainNetwork {
	// tpub -> testnet; xpub -> mainnet. All keys must agree.
	const nets = keys.map((k) => (parseXpub(k.xpub).network === 'mainnet' ? 'mainnet' : 'testnet'));
	if (new Set(nets).size > 1) throw new ImportError('cosigner keys mix networks');
	return nets[0] as ChainNetwork;
}

export function parseDescriptor(rawDesc: string): ParsedDescriptor {
	const desc = stripChecksum(rawDesc.trim());
	if (!desc) throw new ImportError('empty descriptor');

	// tr(...) taproot is out of scope for M2.
	if (desc.startsWith('tr(')) throw new ImportError('taproot (tr) descriptors are not supported yet');

	// Single-sig legacy / native segwit.
	let body: string | null;
	if ((body = unwrap(desc, 'pkh')) !== null) {
		return single(body, 'p2pkh', "m/44'/0'/0'");
	}
	if ((body = unwrap(desc, 'wpkh')) !== null) {
		return single(body, 'p2wpkh', "m/84'/0'/0'");
	}
	if ((body = unwrap(desc, 'wsh')) !== null) {
		const inner = body.trim();
		let mbody: string | null;
		if ((mbody = unwrap(inner, 'sortedmulti')) !== null || (mbody = unwrap(inner, 'multi')) !== null) {
			return parseMulti(mbody, 'p2wsh', "m/48'/0'/0'/2'");
		}
		throw new ImportError('wsh() must wrap sortedmulti()/multi()');
	}
	if ((body = unwrap(desc, 'sh')) !== null) {
		const inner = body.trim();
		let ibody: string | null;
		if ((ibody = unwrap(inner, 'wpkh')) !== null) {
			return single(ibody, 'p2sh-p2wpkh', "m/49'/0'/0'");
		}
		if ((ibody = unwrap(inner, 'wsh')) !== null) {
			let mbody: string | null;
			if (
				(mbody = unwrap(ibody.trim(), 'sortedmulti')) !== null ||
				(mbody = unwrap(ibody.trim(), 'multi')) !== null
			) {
				return parseMulti(mbody, 'p2sh-p2wsh', "m/48'/0'/0'/1'");
			}
			throw new ImportError('sh(wsh(...)) must wrap sortedmulti()/multi()');
		}
		let mbody: string | null;
		if ((mbody = unwrap(inner, 'sortedmulti')) !== null || (mbody = unwrap(inner, 'multi')) !== null) {
			return parseMulti(mbody, 'p2sh', "m/45'");
		}
		throw new ImportError('unsupported sh() descriptor');
	}
	throw new ImportError('unrecognized descriptor script type');
}

function single(body: string, scriptType: SingleScriptType, defaultPath: string): ParsedDescriptor {
	const key = parseKeyExpr(body, defaultPath);
	return {
		kind: 'single',
		scriptType,
		network: inferNetwork([key]),
		threshold: 1,
		keys: [key]
	};
}

// ------------------------------------------------------------- public surface

export interface ImportInput {
	name: string;
	descriptor?: string;
	xpub?: string;
	cosigners?: { xpub: string; fingerprint?: string; path?: string; name?: string }[];
	threshold?: number;
	scriptType?: ScriptType;
	network?: ChainNetwork;
}

function defaultAccountPath(scriptType: ScriptType, network: ChainNetwork): string {
	const coin = network === 'mainnet' ? "0'" : "1'";
	switch (scriptType) {
		case 'p2pkh':
			return `m/44'/${coin}/0'`;
		case 'p2sh-p2wpkh':
			return `m/49'/${coin}/0'`;
		case 'p2wpkh':
			return `m/84'/${coin}/0'`;
		case 'p2wsh':
			return `m/48'/${coin}/0'/2'`;
		case 'p2sh-p2wsh':
			return `m/48'/${coin}/0'/1'`;
		case 'p2sh':
			return `m/45'`;
	}
}

/** Import a wallet. Single-sig and multisig go through ONE path; kind is derived. */
export function importWallet(userId: number, input: ImportInput): Wallet {
	if (!input.name || !input.name.trim()) throw new ImportError('a wallet name is required');

	let parsed: ParsedDescriptor;

	if (input.descriptor) {
		parsed = parseDescriptor(input.descriptor);
		// A standard xpub carries mainnet version bytes but the same key can be
		// watched on testnet/regtest (different address encoding only). Honor an
		// explicit network override for the descriptor path too.
		if (input.network) parsed = { ...parsed, network: input.network };
	} else if (input.cosigners && input.cosigners.length > 1) {
		// Explicit multisig via cosigner list.
		const threshold = input.threshold;
		if (!threshold || threshold < 1 || threshold > input.cosigners.length) {
			throw new ImportError('multisig requires a valid threshold (1..N)');
		}
		const scriptType = (input.scriptType ?? 'p2wsh') as MultisigScriptType;
		const network = input.network ?? 'mainnet';
		const defPath = defaultAccountPath(scriptType, network);
		const keys = input.cosigners.map((c) =>
			parseKeyExpr(keyExprFromParts(c.xpub, c.fingerprint, c.path), defPath)
		);
		parsed = { kind: 'multisig', scriptType, network: inferNetwork(keys), threshold, keys };
	} else if (input.xpub) {
		// Single-sig via xpub -- infer script type from SLIP-132 unless overridden.
		const info = parseXpub(input.xpub);
		const scriptType = (input.scriptType ?? info.inferredScriptType) as SingleScriptType;
		const network = input.network ?? info.network;
		const key: ParsedKey = {
			xpub: info.normalizedXpub,
			fingerprint: '00000000',
			path: defaultAccountPath(scriptType, network)
		};
		parsed = { kind: 'single', scriptType, network, threshold: 1, keys: [key] };
	} else {
		throw new ImportError('provide a descriptor, an xpub, or a cosigner list');
	}

	// Reject duplicate cosigner xpubs (a copy-paste mistake / degenerate multisig).
	const seen = new Set<string>();
	for (const k of parsed.keys) {
		if (seen.has(k.xpub)) throw new ImportError('the same key appears twice');
		seen.add(k.xpub);
	}

	const descriptorForStorage = buildDescriptor(parsed, 0);
	const newWallet: NewWallet = {
		userId,
		name: input.name.trim(),
		kind: parsed.kind,
		scriptType: parsed.scriptType,
		network: parsed.network,
		threshold: parsed.threshold,
		descriptor: descriptorForStorage,
		source: 'imported',
		keys: parsed.keys.map((k, position) => ({
			position,
			xpub: k.xpub,
			fingerprint: k.fingerprint,
			path: k.path,
			name: input.cosigners?.[position]?.name ?? null
		}))
	};
	const walletId = insertWallet(newWallet);
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new ImportError('failed to persist the wallet');
	return wallet;
}

function keyExprFromParts(xpub: string, fingerprint?: string, path?: string): string {
	if (fingerprint && path) {
		const origin = path.replace(/^m\//i, '');
		return `[${fingerprint}/${origin}]${xpub}`;
	}
	return xpub;
}

// -------------------------------------------------------- descriptor emission

/** Emit a BIP-380 output descriptor for a wallet on a chain (0/1), with a
 *  Core-identical `#checksum` (hearth-624.12). */
export function walletToDescriptor(wallet: Wallet, chain: 0 | 1 = 0): string {
	const parsed: ParsedDescriptor = {
		kind: wallet.kind,
		scriptType: wallet.scriptType,
		network: wallet.network,
		threshold: wallet.threshold,
		keys: wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
	};
	return buildDescriptor(parsed, chain);
}

function keyToExpr(k: ParsedKey, chain: 0 | 1): string {
	const origin = k.fingerprint !== '00000000' ? `[${k.fingerprint}/${k.path.replace(/^m\//i, '')}]` : '';
	return `${origin}${k.xpub}/${chain}/*`;
}

function buildDescriptor(parsed: ParsedDescriptor, chain: 0 | 1): string {
	return addDescriptorChecksum(buildDescriptorBody(parsed, chain));
}

function buildDescriptorBody(parsed: ParsedDescriptor, chain: 0 | 1): string {
	if (parsed.kind === 'single') {
		const key = keyToExpr(parsed.keys[0], chain);
		switch (parsed.scriptType) {
			case 'p2pkh':
				return `pkh(${key})`;
			case 'p2wpkh':
				return `wpkh(${key})`;
			case 'p2sh-p2wpkh':
				return `sh(wpkh(${key}))`;
			default:
				throw new InvalidKeyError('single-sig wallet has a multisig script type');
		}
	}
	const inner = `sortedmulti(${parsed.threshold},${parsed.keys.map((k) => keyToExpr(k, chain)).join(',')})`;
	switch (parsed.scriptType) {
		case 'p2wsh':
			return `wsh(${inner})`;
		case 'p2sh-p2wsh':
			return `sh(wsh(${inner}))`;
		case 'p2sh':
			return `sh(${inner})`;
		default:
			throw new InvalidKeyError('multisig wallet has a single-sig script type');
	}
}

// ------------------------------------------------------- thin read re-exports

export function getWallet(userId: number, walletId: number): Wallet | null {
	return getWalletRow(userId, walletId);
}
export function listWallets(userId: number): Wallet[] {
	return listWalletRows(userId);
}
export function deleteWallet(userId: number, walletId: number): boolean {
	return deleteWalletRow(userId, walletId);
}
