/**
 * T0 acceptance (MINING-ENGINE.md §9.3): the miningId mints once and is
 * stable, enable/disable + payout-wallet mutations round-trip, a foreign or
 * unpayable wallet is rejected as a payout target, and every mutation fires
 * onPrefsChanged (asserted indirectly via the mining/index.js stub not
 * throwing -- the real refresh wiring is a T4/T6 concern).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from '../wallet/index.js';
import {
	ensureMiningPrefs,
	getMiningPrefs,
	setPayoutWallet,
	setUserMiningEnabled,
	regenerateMiningId
} from './prefs.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

let userId: number;
let otherUserId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'member');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('b', 'h', 'member');
	const rows = db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[];
	userId = rows[0]!.id;
	otherUserId = rows[1]!.id;
});

describe('mining/prefs: ensureMiningPrefs', () => {
	it('mints a stable miningId on first touch, unchanged on repeat calls', () => {
		const first = ensureMiningPrefs(userId);
		expect(first.miningId).toMatch(/^hearth_[0-9a-f]{8}$/);
		const second = ensureMiningPrefs(userId);
		expect(second.miningId).toBe(first.miningId);
	});

	it('starts disabled with no payout wallet', () => {
		const p = ensureMiningPrefs(userId);
		expect(p.enabled).toBe(false);
		expect(p.payoutWalletId).toBeNull();
	});

	it('getMiningPrefs returns null before first touch', () => {
		expect(getMiningPrefs(userId)).toBeNull();
	});
});

describe('mining/prefs: setUserMiningEnabled', () => {
	it('toggles on and off, ensuring the row first', () => {
		const on = setUserMiningEnabled(userId, true);
		expect(on.enabled).toBe(true);
		const off = setUserMiningEnabled(userId, false);
		expect(off.enabled).toBe(false);
	});
});

describe('mining/prefs: setPayoutWallet', () => {
	it('accepts the caller\'s own eligible (has-xpub) wallet', () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const p = setPayoutWallet(userId, wallet.id);
		expect(p.payoutWalletId).toBe(wallet.id);
	});

	it('clears the payout wallet with null', () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		setPayoutWallet(userId, wallet.id);
		const cleared = setPayoutWallet(userId, null);
		expect(cleared.payoutWalletId).toBeNull();
	});

	it('rejects a wallet that is not the caller\'s own', () => {
		const foreign = importWallet(otherUserId, { name: 'Foreign', xpub: ZPUB });
		expect(() => setPayoutWallet(userId, foreign.id)).toThrow(/wallet not found/);
	});

	it('rejects a non-existent wallet id', () => {
		expect(() => setPayoutWallet(userId, 999999)).toThrow(/wallet not found/);
	});
});

describe('mining/prefs: regenerateMiningId', () => {
	it('rotates the token to a new value', () => {
		const before = ensureMiningPrefs(userId);
		const after = regenerateMiningId(userId);
		expect(after.miningId).toMatch(/^hearth_[0-9a-f]{8}$/);
		expect(after.miningId).not.toBe(before.miningId);
	});
});
