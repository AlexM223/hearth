/**
 * T3 acceptance (WALLET-ENGINE §7): import a watch-only single-sig AND a 2-of-3
 * multisig through ONE path; private-key rejection; getWallet round-trips keys
 * in position order; descriptor/xpub/cosigner-list all land the same schema.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import {
	importWallet,
	getWallet,
	listWallets,
	deleteWallet,
	walletToDescriptor,
	parseDescriptor
} from './index.js';
import { PrivateKeyRejectedError } from './derive.js';
import { addDescriptorChecksum, computeDescriptorChecksum, verifyDescriptorChecksum } from './descsum.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XPRV =
	'xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu';

function accountXpub(seed: number, path = "m/48'/0'/0'/2'"): { xpub: string; fp: string } {
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(seed));
	const acct = root.derive(path);
	return { xpub: acct.publicExtendedKey, fp: hex.encode(u32(root.fingerprint)) };
}
function u32(n: number): Uint8Array {
	return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

let userId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
		'alex',
		'h',
		'owner'
	);
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

describe('T3: single-sig import', () => {
	it('imports a watch-only single-sig from a zpub and infers p2wpkh', () => {
		const w = importWallet(userId, { name: 'Spending', xpub: ZPUB });
		expect(w.kind).toBe('single');
		expect(w.scriptType).toBe('p2wpkh');
		expect(w.threshold).toBe(1);
		expect(w.keys.length).toBe(1);
		expect(w.keys[0].xpub.startsWith('xpub')).toBe(true);
	});

	it('imports a single-sig from a wpkh descriptor with key origin', () => {
		const { xpub, fp } = accountXpub(11, "m/84'/0'/0'");
		const desc = `wpkh([${fp}/84'/0'/0']${xpub}/0/*)`;
		const w = importWallet(userId, { name: 'Desc', descriptor: desc });
		expect(w.kind).toBe('single');
		expect(w.scriptType).toBe('p2wpkh');
		expect(w.keys[0].fingerprint).toBe(fp);
		expect(w.keys[0].path).toBe("m/84'/0'/0'");
	});

	it('getWallet round-trips a persisted single-sig', () => {
		const created = importWallet(userId, { name: 'RT', xpub: ZPUB });
		const fetched = getWallet(userId, created.id);
		expect(fetched).not.toBeNull();
		expect(fetched!.keys[0].xpub).toBe(created.keys[0].xpub);
	});
});

describe('T3: multisig import (2-of-3, one path)', () => {
	function make2of3Descriptor(): string {
		const a = accountXpub(1);
		const b = accountXpub(2);
		const c = accountXpub(3);
		return `wsh(sortedmulti(2,[${a.fp}/48'/0'/0'/2']${a.xpub}/0/*,[${b.fp}/48'/0'/0'/2']${b.xpub}/0/*,[${c.fp}/48'/0'/0'/2']${c.xpub}/0/*))`;
	}

	it('imports a 2-of-3 p2wsh from a sortedmulti descriptor', () => {
		const w = importWallet(userId, { name: 'Vault', descriptor: make2of3Descriptor() });
		expect(w.kind).toBe('multisig');
		expect(w.scriptType).toBe('p2wsh');
		expect(w.threshold).toBe(2);
		expect(w.keys.length).toBe(3);
	});

	it('imports a 2-of-3 from a cosigner list (same schema as the descriptor path)', () => {
		const cos = [1, 2, 3].map((s) => {
			const { xpub, fp } = accountXpub(s);
			return { xpub, fingerprint: fp, path: "m/48'/0'/0'/2'" };
		});
		const w = importWallet(userId, {
			name: 'Vault2',
			cosigners: cos,
			threshold: 2,
			scriptType: 'p2wsh'
		});
		expect(w.kind).toBe('multisig');
		expect(w.threshold).toBe(2);
		expect(w.keys.map((k) => k.position)).toEqual([0, 1, 2]);
	});

	it('keeps keys in stable position order on round-trip', () => {
		const created = importWallet(userId, { name: 'Vault', descriptor: make2of3Descriptor() });
		const fetched = getWallet(userId, created.id)!;
		expect(fetched.keys.map((k) => k.position)).toEqual([0, 1, 2]);
		expect(fetched.keys.map((k) => k.xpub)).toEqual(created.keys.map((k) => k.xpub));
	});
});

describe('T3: import safety + descriptor round-trip', () => {
	it('rejects a private extended key without echoing the secret', () => {
		let thrown: unknown;
		try {
			importWallet(userId, { name: 'Bad', xpub: XPRV });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(PrivateKeyRejectedError);
		expect((thrown as Error).message).not.toContain(XPRV);
	});

	it('rejects a private key hidden inside a descriptor', () => {
		expect(() => importWallet(userId, { name: 'Bad', descriptor: `wpkh(${XPRV})` })).toThrow();
	});

	it('rejects a descriptor whose key origin depth mismatches the xpub', () => {
		const { xpub, fp } = accountXpub(7, "m/84'/0'/0'"); // depth-3 xpub
		const bad = `wpkh([${fp}/84'/0']${xpub}/0/*)`; // claims depth-2 origin
		expect(() => importWallet(userId, { name: 'Bad', descriptor: bad })).toThrow();
	});

	it('walletToDescriptor round-trips back to the same wallet shape', () => {
		const w = importWallet(userId, { name: 'RT', xpub: ZPUB });
		const desc = walletToDescriptor(w, 0);
		const reparsed = parseDescriptor(desc);
		expect(reparsed.kind).toBe('single');
		expect(reparsed.scriptType).toBe('p2wpkh');
		expect(reparsed.keys[0].xpub).toBe(w.keys[0].xpub);
	});

	it('deleteWallet removes it and its keys (cascade)', () => {
		const w = importWallet(userId, { name: 'Tmp', xpub: ZPUB });
		expect(deleteWallet(userId, w.id)).toBe(true);
		expect(getWallet(userId, w.id)).toBeNull();
		expect(listWallets(userId).length).toBe(0);
	});

	it('scopes wallets to their owner (a foreign user cannot fetch)', () => {
		const w = importWallet(userId, { name: 'Mine', xpub: ZPUB });
		expect(getWallet(userId + 999, w.id)).toBeNull();
	});
});

describe('T3: BIP-380 descriptor checksum (hearth-624.12)', () => {
	it('walletToDescriptor emits a valid, Core-identical checksum', () => {
		const w = importWallet(userId, { name: 'Checksummed', xpub: ZPUB });
		const desc = walletToDescriptor(w, 0);
		expect(desc).toMatch(/#[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/);
		expect(verifyDescriptorChecksum(desc)).toBe(true);
	});

	it('the descriptor persisted at import time also carries a valid checksum', () => {
		const w = importWallet(userId, { name: 'StoredChecksum', xpub: ZPUB });
		expect(w.descriptor).not.toBeNull();
		expect(verifyDescriptorChecksum(w.descriptor as string)).toBe(true);
	});

	it('accepts an imported descriptor with a correct checksum', () => {
		const { xpub, fp } = accountXpub(21, "m/84'/0'/0'");
		const body = `wpkh([${fp}/84'/0'/0']${xpub}/0/*)`;
		const desc = addDescriptorChecksum(body);
		const w = importWallet(userId, { name: 'GoodChecksum', descriptor: desc });
		expect(w.keys[0].xpub).toBe(xpub);
	});

	it('rejects an imported descriptor with a wrong checksum, naming the correct one', () => {
		const { xpub, fp } = accountXpub(22, "m/84'/0'/0'");
		const body = `wpkh([${fp}/84'/0'/0']${xpub}/0/*)`;
		const correct = computeDescriptorChecksum(body);
		// Flip the checksum's first character to guarantee a mismatch.
		const wrongChar = correct[0] === 'q' ? 'p' : 'q';
		const wrongChecksum = wrongChar + correct.slice(1);
		const desc = `${body}#${wrongChecksum}`;

		let thrown: unknown;
		try {
			importWallet(userId, { name: 'BadChecksum', descriptor: desc });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain(wrongChecksum);
		expect(message).toContain(correct);
	});

	it('still accepts a checksum-less descriptor (Core/Sparrow compat)', () => {
		const { xpub, fp } = accountXpub(23, "m/84'/0'/0'");
		const body = `wpkh([${fp}/84'/0'/0']${xpub}/0/*)`; // no #checksum
		const w = importWallet(userId, { name: 'NoChecksum', descriptor: body });
		expect(w.keys[0].xpub).toBe(xpub);
	});
});
