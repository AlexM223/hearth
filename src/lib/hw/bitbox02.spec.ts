/**
 * BitBox02 driver tests (SIGNING.md §5.2, T7). A fake `bitbox-api` module for
 * the device-touching entry points (connect -> pair -> register? -> sign);
 * the PSBT/script-config pure logic is exercised directly, no mocking needed
 * for that half. Proves: the pairing-code callback fires only on a first
 * connection (and not when already paired); the wrong-device guard (root-
 * fingerprint roster lookup + a defense-in-depth xpub read) fires BEFORE any
 * registration/signing call; multisig registration is idempotent (skipped
 * when already registered) and always precedes signing; the 45s timeout
 * rejects with 'timeout' (fake timers); and the typed error map classifies
 * locked/abort/no-device correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const b58check = createBase58check(sha256);

function withVersion(xpub: string, version: number): string {
	const raw = b58check.decode(xpub);
	const out = new Uint8Array(raw);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return b58check.encode(out);
}

// ---------------------------------------------------------------------------
// Pure logic -- no device, no mocking.

import {
	isBitbox02Available,
	bitbox02SupportsScriptType,
	singleSigAccountPath,
	bitbox02SupportsMultisigScriptType,
	multisigAccountPath,
	buildSimpleScriptConfig,
	buildMultisigScriptConfig,
	bitboxKeyIdentityMatches,
	accountOriginFromPsbtForBitbox02,
	toBitbox02Error,
	Bitbox02Error,
	type MultisigSignKey
} from './bitbox02.js';

describe('isBitbox02Available', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is false in a Node/SSR environment with no window', () => {
		expect(isBitbox02Available()).toBe(false);
	});

	it('is true whenever `window` exists, even without WebHID -- the BitBoxBridge path remains', () => {
		vi.stubGlobal('window', {});
		expect(isBitbox02Available()).toBe(true);
	});
});

describe('bitbox02SupportsScriptType (single-sig)', () => {
	it('supports SegWit but NOT legacy p2pkh (BIP-44) -- the firmware has no simple type for it', () => {
		expect(bitbox02SupportsScriptType('p2pkh')).toBe(false);
		expect(bitbox02SupportsScriptType('p2sh-p2wpkh')).toBe(true);
		expect(bitbox02SupportsScriptType('p2wpkh')).toBe(true);
	});
});

describe('singleSigAccountPath', () => {
	it('maps each supported script type to its BIP-49/84 account path', () => {
		expect(singleSigAccountPath('p2sh-p2wpkh')).toBe("m/49'/0'/0'");
		expect(singleSigAccountPath('p2wpkh')).toBe("m/84'/0'/0'");
	});

	it('honours a non-default account index', () => {
		expect(singleSigAccountPath('p2wpkh', 3)).toBe("m/84'/0'/3'");
	});

	it('rejects legacy p2pkh with unsupported_script_type', () => {
		expect(() => singleSigAccountPath('p2pkh')).toThrow(Bitbox02Error);
		try {
			singleSigAccountPath('p2pkh');
		} catch (e) {
			expect((e as Bitbox02Error).code).toBe('unsupported_script_type');
		}
	});

	it('rejects a bogus account index', () => {
		expect(() => singleSigAccountPath('p2wpkh', -1)).toThrow(Bitbox02Error);
		expect(() => singleSigAccountPath('p2wpkh', 1.5)).toThrow(Bitbox02Error);
	});
});

describe('bitbox02SupportsMultisigScriptType', () => {
	it('supports p2wsh and p2sh-p2wsh but NOT plain p2sh', () => {
		expect(bitbox02SupportsMultisigScriptType('p2wsh')).toBe(true);
		expect(bitbox02SupportsMultisigScriptType('p2sh-p2wsh')).toBe(true);
		expect(bitbox02SupportsMultisigScriptType('p2sh')).toBe(false);
	});
});

describe('multisigAccountPath', () => {
	it("maps p2wsh to the BIP-48 2' suffix and p2sh-p2wsh to 1', matching $lib/server/wallet/import.ts's defaultAccountPath", () => {
		expect(multisigAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");
		expect(multisigAccountPath('p2sh-p2wsh')).toBe("m/48'/0'/0'/1'");
	});

	it('honours a non-default account index', () => {
		expect(multisigAccountPath('p2wsh', 5)).toBe("m/48'/0'/5'/2'");
	});

	it('rejects plain p2sh multisig', () => {
		expect(() => multisigAccountPath('p2sh')).toThrow(Bitbox02Error);
	});
});

describe('buildSimpleScriptConfig', () => {
	it('builds the device simpleType for each supported script type', () => {
		expect(buildSimpleScriptConfig('p2sh-p2wpkh')).toEqual({ simpleType: 'p2wpkhP2sh' });
		expect(buildSimpleScriptConfig('p2wpkh')).toEqual({ simpleType: 'p2wpkh' });
	});

	it('rejects p2pkh', () => {
		expect(() => buildSimpleScriptConfig('p2pkh')).toThrow(Bitbox02Error);
	});
});

describe('buildMultisigScriptConfig', () => {
	const KEYS: MultisigSignKey[] = [1, 2, 3].map((fill) => {
		const m = HDKey.fromMasterSeed(new Uint8Array(32).fill(fill));
		const acct = m.derive("m/48'/0'/0'/2'");
		return {
			xpub: acct.publicExtendedKey,
			fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
			path: "m/48'/0'/0'/2'"
		};
	});

	it('builds the device multisig config with the ordered xpub set and our index', () => {
		const cfg = buildMultisigScriptConfig(KEYS, 1, 2, 'p2wsh');
		expect(cfg.multisig.threshold).toBe(2);
		expect(cfg.multisig.ourXpubIndex).toBe(1);
		expect(cfg.multisig.scriptType).toBe('p2wsh');
		expect(cfg.multisig.xpubs).toEqual(KEYS.map((k) => k.xpub));
	});

	it('maps p2sh-p2wsh to the device p2wshP2sh script type', () => {
		expect(buildMultisigScriptConfig(KEYS, 0, 2, 'p2sh-p2wsh').multisig.scriptType).toBe('p2wshP2sh');
	});

	it('canonicalizes SLIP-132 cosigner xpubs to standard xpub', () => {
		const zpubKeys = KEYS.map((k) => ({ ...k, xpub: withVersion(k.xpub, 0x02aa7ed3) }));
		const cfg = buildMultisigScriptConfig(zpubKeys, 0, 2, 'p2wsh');
		expect(cfg.multisig.xpubs).toEqual(KEYS.map((k) => k.xpub));
	});

	it('rejects plain p2sh multisig', () => {
		expect(() => buildMultisigScriptConfig(KEYS, 0, 2, 'p2sh')).toThrow(Bitbox02Error);
	});

	it('rejects a nonsense threshold and a bad device index', () => {
		expect(() => buildMultisigScriptConfig(KEYS, 0, 4, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig(KEYS, 0, 0, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig(KEYS, 5, 2, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig([], 0, 1, 'p2wsh')).toThrow(Bitbox02Error);
	});
});

describe('bitboxKeyIdentityMatches', () => {
	const XPUB = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'").publicExtendedKey;
	const expected = { xpub: XPUB, fingerprint: 'd34db33f' };

	it('matches identical account xpubs', () => {
		expect(bitboxKeyIdentityMatches(expected, { xpub: XPUB, fingerprint: '00000000' })).toBe(true);
	});

	it('matches a SLIP-132 alias of the same key', () => {
		expect(bitboxKeyIdentityMatches(expected, { xpub: withVersion(XPUB, 0x02aa7ed3), fingerprint: '00000000' })).toBe(true);
	});

	it('matches on fingerprint fallback when the xpub differs', () => {
		expect(bitboxKeyIdentityMatches(expected, { xpub: 'unreadable', fingerprint: 'D34DB33F' })).toBe(true);
	});

	it('rejects a wholly different device', () => {
		const other = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/84'/0'/0'");
		expect(bitboxKeyIdentityMatches(expected, { xpub: other.publicExtendedKey, fingerprint: 'aaaaaaaa' })).toBe(false);
	});

	it('does not treat placeholder fingerprints as a match', () => {
		expect(bitboxKeyIdentityMatches({ xpub: 'a', fingerprint: '00000000' }, { xpub: 'b', fingerprint: '00000000' })).toBe(false);
	});
});

describe('accountOriginFromPsbtForBitbox02', () => {
	it("reads the fingerprint/path/simpleType straight from the PSBT's own bip32Derivation", async () => {
		closeDb();
		const db: DatabaseSync = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
		db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
		const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
		const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(4));
		const fp = root.fingerprint.toString(16).padStart(8, '0');
		const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		const wallet = importWallet(userId, { name: 'BitBox02', descriptor: `wpkh([${fp}/84'/0'/0']${xpub}/0/*)` });
		const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
		const txid = 'ab'.repeat(32);
		const node: BuildNode = {
			tipHeight: 800100,
			electrum: {
				async batchRequest(items) {
					return items.map((it) => {
						const s = it.params[0] as string;
						if (it.method === 'blockchain.scripthash.get_history') return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
						return s === sh ? { confirmed: 1_000_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
					});
				},
				async listUnspent(scripthash) {
					return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: 1_000_000, height: 800000 }] : [];
				},
				async getTransaction(t) {
					return { txid: t, vin: [], vout: [] };
				}
			}
		};
		const built = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });

		const origin = accountOriginFromPsbtForBitbox02(built.psbtBase64);
		expect(origin.simpleType).toBe('p2wpkh');
		expect(origin.fingerprint >>> 0).toBe(root.fingerprint >>> 0);
	});

	it('rejects an unparsable PSBT before touching anything else', () => {
		expect(() => accountOriginFromPsbtForBitbox02('not-a-psbt')).toThrow(Bitbox02Error);
	});
});

describe('toBitbox02Error', () => {
	it('passes a Bitbox02Error through unchanged', () => {
		const orig = new Bitbox02Error('x', 'bad_psbt');
		expect(toBitbox02Error(orig)).toBe(orig);
	});

	it('classifies an on-device user abort via the library predicate', () => {
		expect(toBitbox02Error(new Error('boom'), { isUserAbort: () => true }).code).toBe('rejected');
	});

	it('classifies a user-abort by the typed error code', () => {
		const e = toBitbox02Error({ code: 'user-abort', message: 'aborted' }, { ensureError: (x) => x as { code: string; message: string } });
		expect(e.code).toBe('rejected');
	});

	it('classifies a locked device BEFORE the generic fallback', () => {
		expect(toBitbox02Error({ code: 'locked', message: 'device is locked' }).code).toBe('device_locked');
	});

	it('classifies a no-device WebHID NotFoundError', () => {
		expect(toBitbox02Error({ name: 'NotFoundError', message: 'no device selected' }).code).toBe('no_device');
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toBitbox02Error(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});

// ---------------------------------------------------------------------------
// Device flow -- fake `bitbox-api` module, real PSBT fixtures (importWallet +
// buildPsbt), no hardware. assertSameTransaction only checks structural
// (inputs/outputs) identity -- not signature validity -- so the fake device
// can hand back the same PSBT bytes unchanged and still prove the commitment
// check passes end to end. Everything below lives inside one `describe` so
// its `window`/`navigator` stubbing (beforeEach/afterEach) never leaks into
// the pure-logic suites above (a top-level, unscoped hook would apply to the
// WHOLE file regardless of textual position -- scoping is load-bearing here).

describe('device flow (fake bitbox-api, no hardware)', () => {

const bitboxState = {
	rootFingerprintImpl: null as null | (() => string),
	btcXpubImpl: null as null | ((keypath: string) => string),
	isScriptConfigRegistered: false,
	pairingCode: undefined as string | undefined,
	connectShouldFail: false,
	calls: [] as string[]
};

function makeFakeMod() {
	return {
		bitbox02ConnectAuto: vi.fn(async () => {
			if (bitboxState.connectShouldFail) throw new Error('could not connect');
			return {
				unlockAndPair: async () => ({
					getPairingCode: () => bitboxState.pairingCode,
					waitConfirm: async () => ({
						rootFingerprint: vi.fn(async () => {
							bitboxState.calls.push('rootFingerprint');
							return bitboxState.rootFingerprintImpl!();
						}),
						btcXpub: vi.fn(async (_coin: string, keypath: string) => {
							bitboxState.calls.push('btcXpub');
							return bitboxState.btcXpubImpl!(keypath);
						}),
						btcIsScriptConfigRegistered: vi.fn(async () => {
							bitboxState.calls.push('check');
							return bitboxState.isScriptConfigRegistered;
						}),
						btcRegisterScriptConfig: vi.fn(async () => {
							bitboxState.calls.push('register');
						}),
						btcSignPSBT: vi.fn(async (_coin: string, psbt: string) => {
							bitboxState.calls.push('sign');
							return psbt; // structurally identical -- proves the commitment check
						}),
						close: vi.fn(() => {
							bitboxState.calls.push('close');
						})
					})
				})
			};
		}),
		ensureError: (e: unknown) => e as { code?: string; message?: string },
		isUserAbort: () => false
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('window', {});
	vi.stubGlobal('navigator', { hid: {} }); // WebHID "available" by default
	bitboxState.rootFingerprintImpl = null;
	bitboxState.btcXpubImpl = null;
	bitboxState.isScriptConfigRegistered = false;
	bitboxState.pairingCode = undefined;
	bitboxState.connectShouldFail = false;
	bitboxState.calls = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('bitbox-api');
	vi.resetModules();
});

async function singleSigFixture(): Promise<{ wallet: Wallet; unsignedPsbt: string; root: HDKey }> {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(4));
	const fp = root.fingerprint.toString(16).padStart(8, '0');
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	const wallet = importWallet(userId, { name: 'BitBox02', descriptor: `wpkh([${fp}/84'/0'/0']${xpub}/0/*)` });
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
	const txid = 'ab'.repeat(32);
	const node: BuildNode = {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history') return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
					return s === sh ? { confirmed: 1_000_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: 1_000_000, height: 800000 }] : [];
			},
			async getTransaction(t) {
				return { txid: t, vin: [], vout: [] };
			}
		}
	};
	const built = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
	return { wallet, unsignedPsbt: built.psbtBase64, root };
}

async function multisigFixture(): Promise<{ wallet: Wallet; unsignedPsbt: string; roots: HDKey[] }> {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
	const roots = [10, 20, 30].map((seed) => HDKey.fromMasterSeed(new Uint8Array(32).fill(seed)));
	const accounts = roots.map((r) => r.derive("m/48'/0'/0'/2'"));
	const fps = roots.map((r) => r.fingerprint.toString(16).padStart(8, '0'));
	const descriptor = `wsh(sortedmulti(2,[${fps[0]}/48'/0'/0'/2']${accounts[0].publicExtendedKey}/0/*,[${fps[1]}/48'/0'/0'/2']${accounts[1].publicExtendedKey}/0/*,[${fps[2]}/48'/0'/0'/2']${accounts[2].publicExtendedKey}/0/*))`;
	const wallet = importWallet(userId, { name: 'Vault', descriptor });
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
	const txid = 'cd'.repeat(32);
	const node: BuildNode = {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history') return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
					return s === sh ? { confirmed: 2_000_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: 2_000_000, height: 800000 }] : [];
			},
			async getTransaction(t) {
				return { txid: t, vin: [], vout: [] };
			}
		}
	};
	const built = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 500_000 }], feeRate: 5 });
	return { wallet, unsignedPsbt: built.psbtBase64, roots };
}

describe('signPsbtWithBitbox02 -- single-sig', () => {
	it('happy path: wrong-device guard passes, the signed PSBT commits to the same transaction', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { unsignedPsbt, root } = await singleSigFixture();
		bitboxState.rootFingerprintImpl = () => root.fingerprint.toString(16).padStart(8, '0');

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		const signed = await signFn(unsignedPsbt);

		const { assertSameTransaction } = await import('$lib/server/wallet/index.js');
		expect(() => assertSameTransaction(unsignedPsbt, signed)).not.toThrow();
		expect(bitboxState.calls).toEqual(['rootFingerprint', 'sign', 'close']);
	});

	it('wrong-device: btcSignPSBT is NEVER called when the device fingerprint does not match', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { unsignedPsbt } = await singleSigFixture();
		bitboxState.rootFingerprintImpl = () => 'aaaaaaaa'; // never matches the wallet's real fingerprint

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn, Bitbox02Error: Err } = await import('./bitbox02.js');
		await expect(signFn(unsignedPsbt)).rejects.toMatchObject({ code: 'wrong_device' });
		expect(bitboxState.calls).toEqual(['rootFingerprint', 'close']);
		void Err;
	});

	it('surfaces the pairing code on a first connection and calls through to sign', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { unsignedPsbt, root } = await singleSigFixture();
		bitboxState.rootFingerprintImpl = () => root.fingerprint.toString(16).padStart(8, '0');
		bitboxState.pairingCode = '123456';

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		const codes: string[] = [];
		await signFn(unsignedPsbt, (code) => codes.push(code));
		expect(codes).toEqual(['123456']);
	});

	it('does not invoke the pairing callback on an already-paired device (code undefined)', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { unsignedPsbt, root } = await singleSigFixture();
		bitboxState.rootFingerprintImpl = () => root.fingerprint.toString(16).padStart(8, '0');
		bitboxState.pairingCode = undefined;

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		const codes: string[] = [];
		await signFn(unsignedPsbt, (code) => codes.push(code));
		expect(codes).toEqual([]);
	});
});

describe('signMultisigPsbtWithBitbox02', () => {
	it('registers an unregistered wallet BEFORE signing (rootFingerprint -> btcXpub -> check -> register -> sign)', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { wallet, unsignedPsbt, roots } = await multisigFixture();
		const keys = wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
		const deviceIdx = 1;
		bitboxState.rootFingerprintImpl = () => roots[deviceIdx].fingerprint.toString(16).padStart(8, '0');
		bitboxState.btcXpubImpl = () => keys[deviceIdx].xpub;
		bitboxState.isScriptConfigRegistered = false;

		vi.resetModules();
		const { signMultisigPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		const signed = await signFn(unsignedPsbt, keys, wallet.threshold, 'p2wsh', `Hearth ${wallet.threshold}-of-${keys.length}`);

		expect(bitboxState.calls).toEqual(['rootFingerprint', 'btcXpub', 'check', 'register', 'sign', 'close']);
		const { assertSameTransaction } = await import('$lib/server/wallet/index.js');
		expect(() => assertSameTransaction(unsignedPsbt, signed)).not.toThrow();
	});

	it('skips registration when the wallet is already registered (check -> sign, no register)', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { wallet, unsignedPsbt, roots } = await multisigFixture();
		const keys = wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
		bitboxState.rootFingerprintImpl = () => roots[0].fingerprint.toString(16).padStart(8, '0');
		bitboxState.btcXpubImpl = () => keys[0].xpub;
		bitboxState.isScriptConfigRegistered = true;

		vi.resetModules();
		const { signMultisigPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await signFn(unsignedPsbt, keys, wallet.threshold, 'p2wsh', 'Vault');

		expect(bitboxState.calls).toEqual(['rootFingerprint', 'btcXpub', 'check', 'sign', 'close']);
	});

	it("wrong-device: a device fingerprint outside the roster is refused before ANY register/xpub/sign call", async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { wallet, unsignedPsbt } = await multisigFixture();
		const keys = wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
		bitboxState.rootFingerprintImpl = () => 'ffffffff'; // not one of the three cosigners

		vi.resetModules();
		const { signMultisigPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await expect(signFn(unsignedPsbt, keys, wallet.threshold, 'p2wsh', 'Vault')).rejects.toMatchObject({
			code: 'wrong_device'
		});
		expect(bitboxState.calls).toEqual(['rootFingerprint', 'close']);
	});

	it('wrong-device: a fingerprint match with a DIFFERENT xpub (same-fp, wrong key material) is refused before registering/signing', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		const { wallet, unsignedPsbt, roots } = await multisigFixture();
		const keys = wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
		const deviceIdx = 0;
		bitboxState.rootFingerprintImpl = () => roots[deviceIdx].fingerprint.toString(16).padStart(8, '0');
		// Claims the right fingerprint slot but hands back an unrelated xpub --
		// the defense-in-depth check this test exists for.
		bitboxState.btcXpubImpl = () => HDKey.fromMasterSeed(new Uint8Array(32).fill(99)).derive("m/48'/0'/0'/2'").publicExtendedKey;

		vi.resetModules();
		const { signMultisigPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await expect(signFn(unsignedPsbt, keys, wallet.threshold, 'p2wsh', 'Vault')).rejects.toMatchObject({
			code: 'wrong_device'
		});
		expect(bitboxState.calls).toEqual(['rootFingerprint', 'btcXpub', 'close']);
	});

	it('rejects an unparsable PSBT before connecting to any device', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		vi.resetModules();
		const { signMultisigPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await expect(signFn('not-a-psbt', [], 1, 'p2wsh', 'x')).rejects.toMatchObject({ code: 'bad_psbt' });
		expect(bitboxState.calls).toEqual([]);
	});
});

describe('connect failures', () => {
	it('a failed connect on a bridge-only browser (no WebHID) explains the BitBoxBridge requirement', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		bitboxState.connectShouldFail = true;
		vi.stubGlobal('navigator', {}); // no navigator.hid -- the Umbrel plain-HTTP case
		const { unsignedPsbt } = await singleSigFixture();

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await expect(signFn(unsignedPsbt)).rejects.toMatchObject({
			code: 'unsupported-browser',
			message: expect.stringContaining('BitBoxBridge')
		});
	});

	it('signPsbtWithBitbox02 rejects outside a browser (no window) before importing bitbox-api behavior matters', async () => {
		vi.doMock('bitbox-api', () => makeFakeMod());
		vi.unstubAllGlobals(); // no window at all
		const { unsignedPsbt } = await singleSigFixture();

		vi.resetModules();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');
		await expect(signFn(unsignedPsbt)).rejects.toMatchObject({ code: 'unavailable' });
	});
});

describe('45s device timeout (fake timers)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a connect that never resolves rejects with the typed timeout error at 45s', async () => {
		vi.doMock('bitbox-api', () => ({
			bitbox02ConnectAuto: vi.fn(() => new Promise(() => {})), // never resolves
			ensureError: (e: unknown) => e as { code?: string; message?: string },
			isUserAbort: () => false
		}));
		vi.resetModules();
		const { unsignedPsbt } = await singleSigFixture();
		const { signPsbtWithBitbox02: signFn } = await import('./bitbox02.js');

		const pending = signFn(unsignedPsbt);
		const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
		await vi.advanceTimersByTimeAsync(45_000);
		await assertion;
	});
});

}); // end describe('device flow (fake bitbox-api, no hardware)')
