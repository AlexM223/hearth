/**
 * Universal wallet-config import (the "any config file just works" layer).
 *
 * One entry point -- parseWalletConfig(content, filename?) -- auto-detects the
 * format and normalizes EVERYTHING to a descriptor-backed import plan that the
 * existing importWallet() path consumes unchanged: single-sig and multisig,
 * one engine, one broadcast path. Formats, all battle-tested shapes ported
 * from Heartwood/bastion's import code:
 *
 *   - Caravan / Unchained wallet JSON  (quorum + extendedPublicKeys)
 *   - Coldcard multisig setup .txt     (Name:/Policy:/Format:/Derivation: +
 *                                       "XFP: xpub" lines, per-key Derivation
 *                                       overrides, SLIP-132 Zpub/Ypub keys)
 *   - Coldcard device export JSON      (coldcard-export.json -- ONE signer;
 *                                       offers its BIP-84 account as a
 *                                       watch-only single-sig)
 *   - Sparrow wallet export JSON       (keystores[] + policyType/scriptType,
 *                                       tolerant of field-name variants)
 *   - Output descriptor                (delegates to parseDescriptor)
 *   - Bare extended key                (xpub/ypub/zpub/... via parseXpub)
 *   - Hearth wallet backup JSON        (this module's own export format)
 *
 * Everything else gets a warm, specific error: a PSBT points to the signing
 * flow, an address points to the Explorer, private key material is refused
 * outright (and never echoed).
 */
import type { ChainNetwork, MultisigScriptType, ScriptType, Wallet } from './types.js';
import { parseDescriptor, walletToDescriptor } from './import.js';
import { parseXpub } from './derive.js';
import { WalletError } from './errors.js';

export class ConfigParseError extends WalletError {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigParseError';
	}
}

const MAX_IMPORT_BYTES = 1_000_000;

export type ConfigFormat =
	| 'caravan'
	| 'coldcard'
	| 'coldcard-device'
	| 'sparrow'
	| 'descriptor'
	| 'xpub'
	| 'hearth-backup';

export interface ConfigPreviewKey {
	fingerprint: string;
	path: string;
	xpub: string;
}

export interface ConfigWalletPlan {
	suggestedName: string | null;
	/** Ready-to-POST /api/wallets body -- the client adds `name`. */
	input: { descriptor?: string; xpub?: string; network?: ChainNetwork };
	preview: {
		kind: 'single' | 'multisig';
		scriptType: ScriptType;
		network: ChainNetwork;
		threshold: number;
		keyCount: number;
		keys: ConfigPreviewKey[];
	};
}

export interface ParsedWalletConfig {
	format: ConfigFormat;
	formatLabel: string;
	wallets: ConfigWalletPlan[];
	/** Non-fatal notices worth showing above the preview. */
	notes: string[];
}

// ------------------------------------------------------------------ helpers

const PRIVATE_KEY_REFUSAL =
	'That contains a PRIVATE key (xprv/yprv/zprv/...). Never paste it anywhere -- ' +
	'import the PUBLIC side only (xpub, descriptor, or wallet config file).';

/** Origin path usable inside a descriptor key expression: m/48'/0'/0'/2' etc.
 *  Caravan masks unknown origins as m/0/0/... -- treat those as "no origin". */
function cleanOriginPath(raw: string | undefined | null): string | null {
	const p = (raw ?? '').trim();
	if (!p || p === 'm' || /^m(\/0)+$/.test(p)) return null;
	if (!/^m(\/\d+['hH]?)+$/.test(p)) return null;
	return p;
}

function keyExpr(xpub: string, fingerprint?: string | null, path?: string | null): string {
	const fp = (fingerprint ?? '').trim();
	const origin = cleanOriginPath(path);
	if (/^[0-9a-fA-F]{8}$/.test(fp) && fp.toLowerCase() !== '00000000' && origin) {
		return `[${fp.toLowerCase()}/${origin.replace(/^m\//, '')}]${xpub}/0/*`;
	}
	return `${xpub}/0/*`;
}

function wrapMultisig(scriptType: MultisigScriptType, inner: string): string {
	switch (scriptType) {
		case 'p2wsh':
			return `wsh(${inner})`;
		case 'p2sh-p2wsh':
			return `sh(wsh(${inner}))`;
		case 'p2sh':
			return `sh(${inner})`;
	}
}

interface RawCosigner {
	xpub: string;
	fingerprint?: string | null;
	path?: string | null;
}

function multisigDescriptor(
	scriptType: MultisigScriptType,
	threshold: number,
	keys: RawCosigner[]
): string {
	const inner = `sortedmulti(${threshold},${keys.map((k) => keyExpr(k.xpub, k.fingerprint, k.path)).join(',')})`;
	return wrapMultisig(scriptType, inner);
}

/** Validate a synthesized/pasted descriptor through the ONE parser and turn it
 *  into a plan. Any network override (Caravan/Sparrow say so explicitly) rides
 *  along into the import input. */
function planFromDescriptor(
	descriptor: string,
	suggestedName: string | null,
	networkOverride?: ChainNetwork
): ConfigWalletPlan {
	const parsed = parseDescriptor(descriptor);
	const network = networkOverride ?? parsed.network;
	return {
		suggestedName,
		input: { descriptor, ...(networkOverride ? { network: networkOverride } : {}) },
		preview: {
			kind: parsed.kind,
			scriptType: parsed.scriptType,
			network,
			threshold: parsed.threshold,
			keyCount: parsed.keys.length,
			keys: parsed.keys.map((k) => ({ fingerprint: k.fingerprint, path: k.path, xpub: k.xpub }))
		}
	};
}

function mapForeignNetwork(raw: unknown, formatName: string): ChainNetwork | undefined {
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	const net = raw.trim().toLowerCase();
	if (net === 'mainnet' || net === 'bitcoin') return 'mainnet';
	if (net === 'testnet' || net === 'testnet3' || net === 'testnet4' || net === 'signet') return 'testnet';
	if (net === 'regtest') return 'regtest';
	throw new ConfigParseError(`this ${formatName} file names an unknown network ("${net}")`);
}

// ------------------------------------------------------------------- Caravan

interface CaravanQuorum {
	requiredSigners?: unknown;
	totalSigners?: unknown;
}
interface CaravanKey {
	name?: unknown;
	bip32Path?: unknown;
	xpub?: unknown;
	xfp?: unknown;
}

const CARAVAN_ADDRESS_TYPES: Record<string, MultisigScriptType> = {
	P2WSH: 'p2wsh',
	'P2SH-P2WSH': 'p2sh-p2wsh',
	P2SH: 'p2sh'
};

function parseCaravan(root: Record<string, unknown>): ParsedWalletConfig {
	const addressTypeRaw = String(root.addressType ?? '').toUpperCase();
	const scriptType = CARAVAN_ADDRESS_TYPES[addressTypeRaw];
	if (!scriptType) {
		throw new ConfigParseError(
			`unknown Caravan address type "${root.addressType}" -- expected P2WSH, P2SH-P2WSH or P2SH`
		);
	}

	const quorum = (root.quorum ?? {}) as CaravanQuorum;
	const threshold = Number(quorum.requiredSigners);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new ConfigParseError('the Caravan file has no usable quorum (quorum.requiredSigners)');
	}

	const rawKeys = root.extendedPublicKeys;
	if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
		throw new ConfigParseError('the Caravan file lists no extended public keys');
	}
	const totalSigners = Number(quorum.totalSigners);
	if (Number.isInteger(totalSigners) && totalSigners > 0 && totalSigners !== rawKeys.length) {
		throw new ConfigParseError(
			`the Caravan file says ${totalSigners} total keys but lists ${rawKeys.length} -- it looks corrupted`
		);
	}

	const cosigners: RawCosigner[] = rawKeys.map((rk, i) => {
		const k = (rk ?? {}) as CaravanKey;
		const xpub = String(k.xpub ?? '').trim();
		if (!xpub) throw new ConfigParseError(`key ${i + 1} in the Caravan file has no xpub`);
		return { xpub, fingerprint: String(k.xfp ?? ''), path: String(k.bip32Path ?? '') };
	});

	const network = mapForeignNetwork(root.network, 'Caravan');
	const name = typeof root.name === 'string' && root.name.trim() ? root.name.trim() : null;
	const descriptor = multisigDescriptor(scriptType, threshold, cosigners);
	return {
		format: 'caravan',
		formatLabel: 'Caravan wallet config',
		wallets: [planFromDescriptor(descriptor, name, network)],
		notes: []
	};
}

// ------------------------------------------------------------------ Coldcard

const COLDCARD_FORMATS: Record<string, MultisigScriptType> = {
	P2WSH: 'p2wsh',
	'P2SH-P2WSH': 'p2sh-p2wsh',
	'P2WSH-P2SH': 'p2sh-p2wsh',
	P2SH: 'p2sh'
};

function looksLikeColdcardTxt(text: string): boolean {
	return (
		/^\s*policy\s*:/im.test(text) && /^\s*[0-9a-fA-F]{8}\s*:\s*[A-Za-z0-9]+\s*$/m.test(text)
	);
}

function parseColdcardTxt(text: string): ParsedWalletConfig {
	let name: string | null = null;
	let threshold = 0;
	let total = 0;
	let scriptType: MultisigScriptType = 'p2wsh';
	let sawFormat = false;
	// A Derivation: line applies to every key that FOLLOWS it, until the next
	// Derivation: line (Coldcard writes one global line, or one per key).
	let currentDerivation: string | null = null;
	const cosigners: RawCosigner[] = [];

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		// Key lines FIRST: "748CC6AA: xpub..." -- a hex fingerprint never
		// matches the alpha-only header pattern below.
		const keyLine = line.match(/^([0-9a-fA-F]{8})\s*:\s*([A-Za-z0-9]+)$/);
		if (keyLine) {
			cosigners.push({ xpub: keyLine[2], fingerprint: keyLine[1], path: currentDerivation });
			continue;
		}

		const header = line.match(/^([A-Za-z ]+?)\s*:\s*(.+)$/);
		if (!header) continue;
		const field = header[1].trim().toLowerCase();
		const value = header[2].trim();

		if (field === 'name') {
			name = value || null;
		} else if (field === 'policy') {
			const m = value.match(/^(\d+)\s+of\s+(\d+)$/i);
			if (!m) throw new ConfigParseError(`unreadable Coldcard policy line ("Policy: ${value}")`);
			threshold = parseInt(m[1], 10);
			total = parseInt(m[2], 10);
		} else if (field === 'format') {
			const mapped = COLDCARD_FORMATS[value.toUpperCase()];
			if (!mapped) {
				throw new ConfigParseError(
					`unknown Coldcard format "${value}" -- expected P2WSH, P2SH-P2WSH or P2SH`
				);
			}
			scriptType = mapped;
			sawFormat = true;
		} else if (field === 'derivation') {
			currentDerivation = value;
		}
		// Unknown "Something: value" headers are tolerated (newer firmware).
	}

	if (threshold < 1) throw new ConfigParseError('the Coldcard file has no "Policy: N of M" line');
	if (cosigners.length === 0) {
		throw new ConfigParseError('the Coldcard file lists no "FINGERPRINT: xpub" key lines');
	}
	if (total > 0 && total !== cosigners.length) {
		throw new ConfigParseError(
			`the Coldcard file says ${total} keys but lists ${cosigners.length} -- it looks truncated`
		);
	}

	const notes: string[] = [];
	if (!sawFormat) notes.push('no "Format:" line -- assumed P2WSH (native segwit)');

	const descriptor = multisigDescriptor(scriptType, threshold, cosigners);
	return {
		format: 'coldcard',
		formatLabel: 'Coldcard multisig setup file',
		wallets: [planFromDescriptor(descriptor, name, undefined)],
		notes
	};
}

/** coldcard-export.json (Advanced -> Export Wallet -> Generic JSON): ONE
 *  device's account keys, not a full multisig config. Offer its BIP-84
 *  account as a watch-only single-sig -- and say so. */
function parseColdcardDeviceExport(root: Record<string, unknown>): ParsedWalletConfig {
	const bip84 = root.bip84 as Record<string, unknown> | undefined;
	const xpub = String(bip84?.xpub ?? '').trim();
	if (!xpub) {
		throw new ConfigParseError(
			'this is a Coldcard device export, but it has no bip84 section -- ' +
				'for a multisig, upload the Coldcard multisig setup .txt instead'
		);
	}
	const fp = String(bip84?.xfp ?? root.xfp ?? '');
	const deriv = String(bip84?.deriv ?? "m/84'/0'/0'");
	const descriptor = `wpkh(${keyExpr(xpub, fp, deriv)})`;
	return {
		format: 'coldcard-device',
		formatLabel: 'Coldcard device export (one signer)',
		wallets: [planFromDescriptor(descriptor, null, undefined)],
		notes: [
			'this file describes ONE Coldcard, not a multisig -- importing it watches that ' +
				"device's own native-segwit account; for a multisig, upload the setup .txt"
		]
	};
}

// ------------------------------------------------------------------- Sparrow

const SPARROW_SCRIPT_TYPES: Record<string, ScriptType> = {
	P2PKH: 'p2pkh',
	'P2SH-P2WPKH': 'p2sh-p2wpkh',
	P2SH_P2WPKH: 'p2sh-p2wpkh',
	P2WPKH: 'p2wpkh',
	P2WSH: 'p2wsh',
	'P2SH-P2WSH': 'p2sh-p2wsh',
	P2SH_P2WSH: 'p2sh-p2wsh',
	P2SH: 'p2sh'
};

interface SparrowKeystore {
	label?: unknown;
	xfp?: unknown;
	masterFingerprint?: unknown;
	derivation?: unknown;
	derivationPath?: unknown;
	xpub?: unknown;
	extendedPublicKey?: unknown;
}

function parseSparrow(root: Record<string, unknown>): ParsedWalletConfig {
	const rawKeystores = root.keystores;
	if (!Array.isArray(rawKeystores) || rawKeystores.length === 0) {
		throw new ConfigParseError('the Sparrow file lists no keystores');
	}

	const scriptRaw = String(root.scriptType ?? '').toUpperCase();
	if (scriptRaw === 'P2TR') {
		throw new ConfigParseError('taproot (P2TR) wallets are not supported yet');
	}
	const scriptType = SPARROW_SCRIPT_TYPES[scriptRaw];
	if (!scriptType) {
		throw new ConfigParseError(
			`unknown Sparrow script type "${root.scriptType}" -- expected P2WPKH/P2SH-P2WPKH/P2PKH/P2WSH/P2SH-P2WSH/P2SH`
		);
	}

	const cosigners: RawCosigner[] = rawKeystores.map((rk, i) => {
		const ks = (rk ?? {}) as SparrowKeystore;
		const xpub = String(ks.xpub ?? ks.extendedPublicKey ?? '').trim();
		if (!xpub) throw new ConfigParseError(`keystore ${i + 1} in the Sparrow file has no xpub`);
		return {
			xpub,
			fingerprint: String(ks.xfp ?? ks.masterFingerprint ?? ''),
			path: String(ks.derivation ?? ks.derivationPath ?? '')
		};
	});

	const policyType = String(root.policyType ?? '').toUpperCase();
	const multi = policyType === 'MULTI' || cosigners.length > 1;

	const name = typeof root.label === 'string' && root.label.trim() ? root.label.trim() : null;
	const network = mapForeignNetwork(root.network, 'Sparrow');

	let descriptor: string;
	if (multi) {
		const defaultPolicy = (root.defaultPolicy ?? {}) as Record<string, unknown>;
		let threshold = Number(defaultPolicy.numSignaturesRequired ?? root.numSignaturesRequired);
		if (!Number.isInteger(threshold) || threshold < 1) {
			// Last resort: the policy miniscript ("multi(2,...)" / "sortedmulti(2,...)").
			const script = String(defaultPolicy.script ?? '');
			const m = script.match(/(?:sorted)?multi\s*\(\s*(\d+)\s*,/i);
			threshold = m ? parseInt(m[1], 10) : NaN;
		}
		if (!Number.isInteger(threshold) || threshold < 1) {
			throw new ConfigParseError(
				"couldn't find the multisig threshold in the Sparrow file -- " +
					'export the wallet from Sparrow as a Caravan or Coldcard file instead'
			);
		}
		if (scriptType !== 'p2wsh' && scriptType !== 'p2sh-p2wsh' && scriptType !== 'p2sh') {
			throw new ConfigParseError('the Sparrow file mixes a multisig policy with a single-sig script type');
		}
		descriptor = multisigDescriptor(scriptType, threshold, cosigners);
	} else {
		const k = cosigners[0];
		const expr = keyExpr(k.xpub, k.fingerprint, k.path);
		if (scriptType === 'p2wpkh') descriptor = `wpkh(${expr})`;
		else if (scriptType === 'p2sh-p2wpkh') descriptor = `sh(wpkh(${expr}))`;
		else if (scriptType === 'p2pkh') descriptor = `pkh(${expr})`;
		else throw new ConfigParseError('the Sparrow file mixes a single keystore with a multisig script type');
	}

	return {
		format: 'sparrow',
		formatLabel: 'Sparrow wallet export',
		wallets: [planFromDescriptor(descriptor, name, network)],
		notes: []
	};
}

// ------------------------------------------------------------- Hearth backup

export const HEARTH_BACKUP_FORMAT = 'hearth-wallet-backup';
export const HEARTH_BACKUP_VERSION = 1;

export interface HearthWalletBackup {
	format: typeof HEARTH_BACKUP_FORMAT;
	version: number;
	exportedAt: string;
	wallets: { name: string; descriptor: string; network: ChainNetwork }[];
}

/** Build the downloadable backup for a user's wallets: public data only
 *  (names + output descriptors) -- exactly what re-import needs, nothing else. */
export function buildWalletBackup(wallets: Wallet[]): HearthWalletBackup {
	return {
		format: HEARTH_BACKUP_FORMAT,
		version: HEARTH_BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		wallets: wallets.map((w) => ({
			name: w.name,
			descriptor: walletToDescriptor(w, 0),
			network: w.network
		}))
	};
}

function parseHearthBackup(root: Record<string, unknown>): ParsedWalletConfig {
	const version = Number(root.version);
	if (Number.isInteger(version) && version > HEARTH_BACKUP_VERSION) {
		throw new ConfigParseError(
			'this backup was made by a newer version of Hearth and cannot be restored here'
		);
	}
	const rawWallets = root.wallets;
	if (!Array.isArray(rawWallets) || rawWallets.length === 0) {
		throw new ConfigParseError('the Hearth backup lists no wallets');
	}
	const wallets = rawWallets.map((rw, i) => {
		const w = (rw ?? {}) as { name?: unknown; descriptor?: unknown; network?: unknown };
		const descriptor = String(w.descriptor ?? '').trim();
		if (!descriptor) throw new ConfigParseError(`wallet ${i + 1} in the backup has no descriptor`);
		const name = typeof w.name === 'string' && w.name.trim() ? w.name.trim() : `Restored wallet ${i + 1}`;
		const network = mapForeignNetwork(w.network, 'Hearth backup');
		return planFromDescriptor(descriptor, name, network);
	});
	return { format: 'hearth-backup', formatLabel: 'Hearth wallet backup', wallets, notes: [] };
}

// ------------------------------------------------------------ the one parser

export function parseWalletConfig(content: string, filename?: string | null): ParsedWalletConfig {
	if (typeof content !== 'string' || !content.trim()) {
		throw new ConfigParseError('the file is empty');
	}
	if (content.length > MAX_IMPORT_BYTES) {
		throw new ConfigParseError('that file is too large to be a wallet config');
	}
	const text = content.trim();

	// Private key material: refuse before ANY other processing, never echo.
	if (/[xyztuv]prv/i.test(text)) throw new ConfigParseError(PRIVATE_KEY_REFUSAL);

	// A PSBT is a transaction to sign, not a wallet to import.
	const squashed = text.replace(/\s+/g, '');
	if (/^cHNidP/.test(squashed) || text.startsWith('psbt\xff')) {
		throw new ConfigParseError(
			'this is a PSBT (a transaction to sign), not a wallet config -- open the wallet ' +
				"you're spending from and use its Sign step (Sign with file), or import the wallet first"
		);
	}

	// A single address is watchable in the Explorer, but it isn't a wallet.
	if (/^(bc1|tb1|bcrt1)[a-z0-9]{6,90}$/i.test(squashed) || /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(squashed)) {
		throw new ConfigParseError(
			"that's a single Bitcoin address -- Hearth watches whole wallets (xpub or descriptor); " +
				'to look up one address, use the Explorer search instead'
		);
	}

	if (text.startsWith('{') || text.startsWith('[')) {
		let root: unknown;
		try {
			root = JSON.parse(text);
		} catch {
			throw new ConfigParseError(
				"that looks like JSON but doesn't parse -- re-export the file and try again"
			);
		}
		if (typeof root !== 'object' || root === null || Array.isArray(root)) {
			throw new ConfigParseError(
				'unrecognized JSON -- Hearth accepts Caravan, Sparrow, Coldcard exports, or a Hearth wallet backup'
			);
		}
		const obj = root as Record<string, unknown>;
		if (obj.format === HEARTH_BACKUP_FORMAT) return parseHearthBackup(obj);
		if (obj.quorum !== undefined || obj.extendedPublicKeys !== undefined) return parseCaravan(obj);
		if (Array.isArray(obj.keystores)) return parseSparrow(obj);
		if (obj.bip84 !== undefined || (obj.xfp !== undefined && obj.bip48_2 !== undefined)) {
			return parseColdcardDeviceExport(obj);
		}
		throw new ConfigParseError(
			'unrecognized JSON wallet file -- Hearth accepts Caravan (quorum + extendedPublicKeys), ' +
				'Sparrow (keystores), a Coldcard device export, or a Hearth wallet backup'
		);
	}

	if (looksLikeColdcardTxt(text)) return parseColdcardTxt(text);

	if (/^(pkh|wpkh|sh|wsh|tr|combo)\(/.test(text)) {
		return {
			format: 'descriptor',
			formatLabel: 'Output descriptor',
			wallets: [planFromDescriptor(text, null, undefined)],
			notes: []
		};
	}

	if (/^[A-Za-z]pub[1-9A-HJ-NP-Za-km-z]{20,}$/.test(squashed)) {
		const info = parseXpub(squashed);
		if (info.inferredScriptType === 'p2wsh' || info.inferredScriptType === 'p2sh-p2wsh') {
			throw new ConfigParseError(
				'that is a MULTISIG extended key (Zpub/Ypub) -- upload the full multisig config ' +
					'(Caravan/Coldcard/Sparrow file) it belongs to, or its wsh(sortedmulti(...)) descriptor'
			);
		}
		return {
			format: 'xpub',
			formatLabel: 'Extended public key',
			wallets: [
				{
					suggestedName: null,
					input: { xpub: squashed },
					preview: {
						kind: 'single',
						scriptType: info.inferredScriptType,
						network: info.network,
						threshold: 1,
						keyCount: 1,
						keys: [
							{
								fingerprint: info.selfFingerprint,
								path: 'm',
								xpub: info.normalizedXpub
							}
						]
					}
				}
			],
			notes: []
		};
	}

	const hint = filename ? ` ("${filename}")` : '';
	throw new ConfigParseError(
		`couldn't recognize that${hint} -- Hearth accepts a Caravan JSON, a Coldcard multisig .txt, ` +
			'a Sparrow wallet export, an output descriptor, an xpub/ypub/zpub, or a Hearth wallet backup'
	);
}
