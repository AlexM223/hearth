/**
 * T4 acceptance (MINING-ENGINE.md §9.1, §3.1): resolve() is a pure sync Map
 * lookup; refreshAuthTable builds one entry per enabled+payable mining_prefs
 * row; a single bad row (missing wallet, wrong-network address) is skipped
 * without dropping other miners; the swap is atomic (never a half-built map).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from '../wallet/index.js';
import { ensureMiningPrefs, setPayoutWallet, setUserMiningEnabled } from './prefs.js';
import { getAuthTable, refreshAuthTable, __resetAuthTableForTests } from './authTable.js';
import { networkFor } from './address.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/**
 * Force a wallet's stored `network` column to a different value than the
 * xpub it actually holds (hearth-ny4.6: importing a REAL tpub/upub/vpub
 * literal string currently throws "Version mismatch" from @scure/bip32's
 * HDKey.fromExtendedKey, a latent M2 wallet/derive.ts defect -- parseXpub
 * re-versions the payload to the SLIP-132-inferred network's own xpub
 * version before calling fromExtendedKey, but that function only accepts
 * mainnet version bytes without an explicit `versions` option). Flagged as
 * hearth-ny4.6 for the wallet module owner rather than fixed here (out of
 * M5's scope). This helper reproduces the cross-network scenario authTable
 * needs to test -- a wallet whose OWN network doesn't match the engine's
 * resolved network -- without needing a real testnet-versioned key import:
 * `deriveAddresses`/`peekReceiveAddress` derive an address using WHATEVER
 * `wallet.network` says (that's what actually selects the bech32 hrp), so
 * mutating just that column after a normal mainnet import is sufficient.
 */
function forceWalletNetwork(walletId: number, network: string): void {
	getDb().prepare('UPDATE wallets SET network = ? WHERE id = ?').run(network, walletId);
}

let userId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'member');
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	__resetAuthTableForTests();
});

describe('mining/authTable: resolve', () => {
	it('is a pure synchronous lookup returning null for an unknown id', () => {
		expect(getAuthTable().resolve('nope')).toBeNull();
	});
});

describe('mining/authTable: refreshAuthTable', () => {
	it('populates one entry for an enabled miner with a payable wallet, on the correct network', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB }); // mainnet xpub
		const prefs = ensureMiningPrefs(userId);
		setPayoutWallet(userId, wallet.id);
		setUserMiningEnabled(userId, true);

		await refreshAuthTable(networkFor('mainnet'));

		const auth = getAuthTable().resolve(prefs.miningId!);
		expect(auth).not.toBeNull();
		expect(auth!.userId).toBe(userId);
		expect(auth!.walletId).toBe(wallet.id);
		expect(auth!.payoutScript.length).toBeGreaterThan(0);
	});

	it('excludes a disabled miner', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const prefs = ensureMiningPrefs(userId);
		setPayoutWallet(userId, wallet.id);
		// enabled stays false (default)
		await refreshAuthTable(networkFor('mainnet'));
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});

	it('excludes a miner with no payout wallet set', async () => {
		const prefs = ensureMiningPrefs(userId);
		setUserMiningEnabled(userId, true);
		await refreshAuthTable(networkFor('mainnet'));
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});

	it('a wallet whose network does not match the resolved network is skipped, not crashed', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		forceWalletNetwork(wallet.id, 'testnet'); // now claims testnet while the key is mainnet-format
		const prefs = ensureMiningPrefs(userId);
		setPayoutWallet(userId, wallet.id);
		setUserMiningEnabled(userId, true);

		// Refresh against MAINNET while the wallet claims TESTNET -- the derived
		// address's bech32 prefix won't match, addressToOutputScript throws,
		// and this one bad row is skipped (never crashes the whole rebuild).
		await expect(refreshAuthTable(networkFor('mainnet'))).resolves.toBeUndefined();
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});

	it('one bad row never drops OTHER good miners in the same rebuild', async () => {
		db2InsertSecondUser();
		const goodWallet = importWallet(userId, { name: 'Good', xpub: ZPUB });
		const goodPrefs = ensureMiningPrefs(userId);
		setPayoutWallet(userId, goodWallet.id);
		setUserMiningEnabled(userId, true);

		const badUserId = secondUserId;
		const badWallet = importWallet(badUserId, { name: 'Bad', xpub: ZPUB });
		forceWalletNetwork(badWallet.id, 'testnet'); // wrong network vs. the mainnet refresh below
		const badPrefs = ensureMiningPrefs(badUserId);
		setPayoutWallet(badUserId, badWallet.id);
		setUserMiningEnabled(badUserId, true);

		await refreshAuthTable(networkFor('mainnet'));

		expect(getAuthTable().resolve(goodPrefs.miningId!)).not.toBeNull();
		expect(getAuthTable().resolve(badPrefs.miningId!)).toBeNull();
	});

	it('is an atomic swap -- resolve() during a rebuild never sees a half-built map (single-threaded proxy: old entries stay until replace)', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const prefs = ensureMiningPrefs(userId);
		setPayoutWallet(userId, wallet.id);
		setUserMiningEnabled(userId, true);
		await refreshAuthTable(networkFor('mainnet'));
		expect(getAuthTable().size).toBe(1);

		// A second refresh with nobody enabled clears it in one atomic swap.
		setUserMiningEnabled(userId, false);
		await refreshAuthTable(networkFor('mainnet'));
		expect(getAuthTable().size).toBe(0);
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});
});

let secondUserId: number;
function db2InsertSecondUser(): void {
	getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('b', 'h', 'member');
	secondUserId = Number(
		(getDb().prepare("SELECT id FROM users WHERE username = 'b'").get() as { id: number }).id
	);
}
