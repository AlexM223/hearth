/**
 * Universal wallet-config import: every foreign format lands on the SAME
 * descriptor-backed plan the one importWallet() path consumes. Fixtures are
 * real-shaped (Caravan/Unchained JSON, Coldcard multisig .txt with global and
 * per-key Derivation lines and SLIP-132 Zpub keys, Sparrow exports, Coldcard
 * device exports, Hearth backups) -- field names and grammar verified against
 * the battle-tested Heartwood/bastion importers this module ports.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { base58check, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { parseWalletConfig, buildWalletBackup, ConfigParseError } from './configImport.js';
import { importWallet, listWallets } from './import.js';

const b58check = base58check(sha256);

function accountKey(seed: number, path: string): { xpub: string; fp: string } {
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(seed));
	const acct = root.derive(path);
	const fp = hex.encode(
		Uint8Array.from([
			(root.fingerprint >>> 24) & 0xff,
			(root.fingerprint >>> 16) & 0xff,
			(root.fingerprint >>> 8) & 0xff,
			root.fingerprint & 0xff
		])
	);
	return { xpub: acct.publicExtendedKey, fp };
}

/** Re-stamp an xpub with SLIP-132 version bytes (Zpub etc.) for fixtures. */
function slip132(xpub: string, version: number): string {
	const payload = b58check.decode(xpub);
	const out = new Uint8Array(payload);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return b58check.encode(out);
}

const MS_PATH = "m/48'/0'/0'/2'";
const A = accountKey(1, MS_PATH);
const B = accountKey(2, MS_PATH);
const C = accountKey(3, MS_PATH);
const SINGLE = accountKey(4, "m/84'/0'/0'");

const ZPUB_SINGLE =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('Caravan wallet config', () => {
	const caravan = {
		name: 'Family vault',
		addressType: 'P2WSH',
		network: 'mainnet',
		quorum: { requiredSigners: 2, totalSigners: 3 },
		startingAddressIndex: 0,
		extendedPublicKeys: [
			{ name: 'Coldcard', bip32Path: MS_PATH, xpub: A.xpub, xfp: A.fp.toUpperCase() },
			{ name: 'Trezor', bip32Path: MS_PATH, xpub: B.xpub, xfp: B.fp },
			// Caravan masks an unknown origin as m/0/0/... -- must not become an origin.
			{ name: 'Paper', bip32Path: 'm/0/0/0/0', xpub: C.xpub, xfp: '' }
		]
	};

	it('parses a 2-of-3 P2WSH config into one multisig plan', () => {
		const parsed = parseWalletConfig(JSON.stringify(caravan));
		expect(parsed.format).toBe('caravan');
		expect(parsed.wallets).toHaveLength(1);
		const plan = parsed.wallets[0];
		expect(plan.suggestedName).toBe('Family vault');
		expect(plan.preview).toMatchObject({
			kind: 'multisig',
			scriptType: 'p2wsh',
			network: 'mainnet',
			threshold: 2,
			keyCount: 3
		});
		// Uppercase xfp normalized; masked path key gets the placeholder fingerprint.
		expect(plan.preview.keys[0].fingerprint).toBe(A.fp);
		expect(plan.preview.keys[2].fingerprint).toBe('00000000');
		expect(plan.input.descriptor).toContain('sortedmulti(2,');
	});

	it('the plan round-trips through the real importWallet()', () => {
		const parsed = parseWalletConfig(JSON.stringify(caravan));
		const w = importWallet(userId, { name: 'Family vault', ...parsed.wallets[0].input });
		expect(w.kind).toBe('multisig');
		expect(w.threshold).toBe(2);
		expect(w.keys).toHaveLength(3);
	});

	it('rejects a quorum/key-count mismatch as corrupted', () => {
		const bad = { ...caravan, quorum: { requiredSigners: 2, totalSigners: 4 } };
		expect(() => parseWalletConfig(JSON.stringify(bad))).toThrow(/looks corrupted/);
	});

	it('rejects an unknown addressType by name', () => {
		const bad = { ...caravan, addressType: 'P2TR' };
		expect(() => parseWalletConfig(JSON.stringify(bad))).toThrow(/address type/i);
	});
});

describe('Coldcard multisig setup .txt', () => {
	const GLOBAL_DERIVATION = [
		'# Coldcard Multisig setup file (exported from unchained)',
		'#',
		'Name: cc-vault',
		'Policy: 2 of 3',
		`Derivation: ${MS_PATH}`,
		'Format: P2WSH',
		'',
		`${A.fp.toUpperCase()}: ${A.xpub}`,
		`${B.fp.toUpperCase()}: ${B.xpub}`,
		`${C.fp.toUpperCase()}: ${C.xpub}`
	].join('\n');

	it('parses the global-Derivation form', () => {
		const parsed = parseWalletConfig(GLOBAL_DERIVATION);
		expect(parsed.format).toBe('coldcard');
		const plan = parsed.wallets[0];
		expect(plan.suggestedName).toBe('cc-vault');
		expect(plan.preview).toMatchObject({ kind: 'multisig', scriptType: 'p2wsh', threshold: 2, keyCount: 3 });
		expect(plan.preview.keys.map((k) => k.fingerprint)).toEqual([A.fp, B.fp, C.fp]);
		expect(plan.preview.keys[0].path).toBe(MS_PATH);
	});

	it('parses per-key Derivation lines and SLIP-132 Zpub keys', () => {
		const zpubA = slip132(A.xpub, 0x02aa7ed3);
		const text = [
			'Name: mixed-paths',
			'Policy: 2 of 2',
			'Format: P2WSH',
			`Derivation: ${MS_PATH}`,
			`${A.fp}: ${zpubA}`,
			"Derivation: m/48'/0'/1'/2'",
			`${B.fp}: ${accountKey(2, "m/48'/0'/1'/2'").xpub}`
		].join('\n');
		const parsed = parseWalletConfig(text);
		const plan = parsed.wallets[0];
		expect(plan.preview.keys[0].path).toBe(MS_PATH);
		expect(plan.preview.keys[1].path).toBe("m/48'/0'/1'/2'");
		// The Zpub normalized to a standard xpub in the preview.
		expect(plan.preview.keys[0].xpub).toBe(A.xpub);
	});

	it('rejects a truncated file (Policy says 3, lists 2)', () => {
		const text = ['Policy: 2 of 3', 'Format: P2WSH', `Derivation: ${MS_PATH}`, `${A.fp}: ${A.xpub}`, `${B.fp}: ${B.xpub}`].join(
			'\n'
		);
		expect(() => parseWalletConfig(text)).toThrow(/truncated/);
	});
});

describe('Sparrow wallet export', () => {
	it('parses a single-sig P2WPKH export', () => {
		const sparrow = {
			label: 'Sparrow spending',
			scriptType: 'P2WPKH',
			policyType: 'SINGLE',
			keystores: [{ label: 'Keystone', xfp: SINGLE.fp, derivation: "m/84'/0'/0'", xpub: SINGLE.xpub }]
		};
		const parsed = parseWalletConfig(JSON.stringify(sparrow));
		expect(parsed.format).toBe('sparrow');
		const plan = parsed.wallets[0];
		expect(plan.suggestedName).toBe('Sparrow spending');
		expect(plan.preview).toMatchObject({ kind: 'single', scriptType: 'p2wpkh', threshold: 1 });
		expect(plan.preview.keys[0].fingerprint).toBe(SINGLE.fp);
	});

	it('parses a MULTI export using defaultPolicy.numSignaturesRequired', () => {
		const sparrow = {
			label: 'Sparrow vault',
			scriptType: 'P2WSH',
			policyType: 'MULTI',
			defaultPolicy: { numSignaturesRequired: 2 },
			keystores: [
				{ xfp: A.fp, derivation: MS_PATH, xpub: A.xpub },
				{ xfp: B.fp, derivation: MS_PATH, xpub: B.xpub },
				{ xfp: C.fp, derivation: MS_PATH, xpub: C.xpub }
			]
		};
		const parsed = parseWalletConfig(JSON.stringify(sparrow));
		expect(parsed.wallets[0].preview).toMatchObject({ kind: 'multisig', threshold: 2, keyCount: 3 });
	});

	it('falls back to the policy miniscript for the threshold', () => {
		const sparrow = {
			scriptType: 'P2WSH',
			policyType: 'MULTI',
			defaultPolicy: { script: 'wsh(sortedmulti(2,k1,k2,k3))' },
			keystores: [
				{ xfp: A.fp, derivation: MS_PATH, xpub: A.xpub },
				{ xfp: B.fp, derivation: MS_PATH, xpub: B.xpub },
				{ xfp: C.fp, derivation: MS_PATH, xpub: C.xpub }
			]
		};
		expect(parseWalletConfig(JSON.stringify(sparrow)).wallets[0].preview.threshold).toBe(2);
	});

	it('rejects taproot with a clear message', () => {
		const sparrow = { scriptType: 'P2TR', keystores: [{ xpub: SINGLE.xpub }] };
		expect(() => parseWalletConfig(JSON.stringify(sparrow))).toThrow(/taproot/i);
	});
});

describe('Coldcard device export (Generic JSON)', () => {
	it('offers the BIP-84 account as a watch-only single-sig, with a note', () => {
		const exportJson = {
			chain: 'BTC',
			xfp: SINGLE.fp.toUpperCase(),
			bip84: { name: 'p2wpkh', xfp: SINGLE.fp.toUpperCase(), deriv: "m/84'/0'/0'", xpub: SINGLE.xpub },
			bip48_2: { deriv: MS_PATH, xpub: A.xpub, xfp: A.fp }
		};
		const parsed = parseWalletConfig(JSON.stringify(exportJson));
		expect(parsed.format).toBe('coldcard-device');
		expect(parsed.notes[0]).toMatch(/ONE Coldcard/);
		expect(parsed.wallets[0].preview).toMatchObject({ kind: 'single', scriptType: 'p2wpkh' });
	});
});

describe('descriptor and bare xpub passthrough', () => {
	it('parses a wsh(sortedmulti()) descriptor', () => {
		const desc = `wsh(sortedmulti(2,[${A.fp}/48'/0'/0'/2']${A.xpub}/0/*,[${B.fp}/48'/0'/0'/2']${B.xpub}/0/*))`;
		const parsed = parseWalletConfig(desc);
		expect(parsed.format).toBe('descriptor');
		expect(parsed.wallets[0].preview).toMatchObject({ kind: 'multisig', threshold: 2 });
	});

	it('parses a bare zpub as single-sig p2wpkh', () => {
		const parsed = parseWalletConfig(ZPUB_SINGLE);
		expect(parsed.format).toBe('xpub');
		expect(parsed.wallets[0].input.xpub).toBe(ZPUB_SINGLE);
		expect(parsed.wallets[0].preview).toMatchObject({ kind: 'single', scriptType: 'p2wpkh' });
	});

	it('tells a multisig Zpub to bring its whole config', () => {
		expect(() => parseWalletConfig(slip132(A.xpub, 0x02aa7ed3))).toThrow(/MULTISIG extended key/);
	});
});

describe('Hearth wallet backup', () => {
	it('export -> parse -> re-import round-trips every wallet', () => {
		importWallet(userId, { name: 'Spending', xpub: ZPUB_SINGLE });
		importWallet(userId, {
			name: 'Vault',
			descriptor: `wsh(sortedmulti(2,[${A.fp}/48'/0'/0'/2']${A.xpub}/0/*,[${B.fp}/48'/0'/0'/2']${B.xpub}/0/*))`
		});
		const backup = buildWalletBackup(listWallets(userId));
		expect(backup.wallets).toHaveLength(2);

		const parsed = parseWalletConfig(JSON.stringify(backup));
		expect(parsed.format).toBe('hearth-backup');
		expect(parsed.wallets).toHaveLength(2);
		expect(parsed.wallets.map((w) => w.suggestedName)).toEqual(['Spending', 'Vault']);

		// Restore into a second user: both plans import cleanly.
		for (const plan of parsed.wallets) {
			const w = importWallet(otherUserId, { name: plan.suggestedName!, ...plan.input });
			expect(w.id).toBeGreaterThan(0);
		}
		expect(listWallets(otherUserId)).toHaveLength(2);
	});

	it('rejects a backup from the future', () => {
		const future = { format: 'hearth-wallet-backup', version: 99, wallets: [{ name: 'x', descriptor: 'wpkh(x)' }] };
		expect(() => parseWalletConfig(JSON.stringify(future))).toThrow(/newer version/);
	});
});

describe('hostile and wrong-kind inputs', () => {
	it('refuses private key material outright, never echoing it', () => {
		try {
			parseWalletConfig(`{"seed": "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu"}`);
			expect.unreachable('should have thrown');
		} catch (e) {
			expect((e as Error).message).toMatch(/PRIVATE key/);
			expect((e as Error).message).not.toMatch(/xprv9/);
		}
	});

	it('points a PSBT at the signing flow', () => {
		expect(() => parseWalletConfig('cHNidP8BAHECAAAAAA==')).toThrow(/transaction to sign/);
	});

	it('points a bare address at the Explorer', () => {
		expect(() => parseWalletConfig('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toThrow(/Explorer/);
	});

	it('rejects an empty and an oversized payload', () => {
		expect(() => parseWalletConfig('   ')).toThrow(/empty/);
		expect(() => parseWalletConfig('x'.repeat(1_000_001))).toThrow(/too large/);
	});

	it('names the accepted formats when nothing matches', () => {
		expect(() => parseWalletConfig('hello world', 'notes.txt')).toThrow(/Caravan/);
	});

	it('all hostile-input errors are ConfigParseError with clean messages', () => {
		for (const input of ['   ', 'hello world', 'cHNidP8BAHECAAAAAA==', '{"not":"json wallet"}']) {
			try {
				parseWalletConfig(input);
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(ConfigParseError);
				expect((e as Error).message.length).toBeLessThan(500);
			}
		}
	});
});

let userId: number;
let otherUserId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alex', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mum', 'h', 'member');
	const rows = db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[];
	userId = rows[0].id;
	otherUserId = rows[1].id;
});
