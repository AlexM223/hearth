/**
 * T1 acceptance (WATCHTOWER.md §1.7): the `notified_txids` dedup ledger.
 * alreadyNotified treats 'pending' as NOT YET notified; claimReceived is the
 * atomic mempool->block transition (exactly one concurrent winner);
 * baselineTxids silently records history without ever suppressing a
 * genuinely-tracked pending row.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, withTransaction, getDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import {
	getLedgerRow,
	alreadyNotified,
	trackPendingInbound,
	claimReceived,
	baselineTxids
} from './ledger.js';

let walletId: number;
let userId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'owner')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	db.prepare(
		`INSERT INTO wallets (user_id, name, kind, script_type, network, threshold, source) VALUES (?, 'w', 'single', 'p2wpkh', 'mainnet', 1, 'imported')`
	).run(userId);
	walletId = Number((db.prepare('SELECT id FROM wallets').get() as { id: number }).id);
});

describe('T1: ledger.ts (notified_txids)', () => {
	it('getLedgerRow returns null for an unrecorded txid', () => {
		expect(getLedgerRow(walletId, userId, 'aaaa')).toBeNull();
	});

	it('alreadyNotified is false for an unrecorded txid', () => {
		expect(alreadyNotified(walletId, userId, 'aaaa')).toBe(false);
	});

	it('trackPendingInbound records a pending row; alreadyNotified stays false (must still fire once confirmed)', () => {
		trackPendingInbound(walletId, userId, 'bbbb', 50000);
		const row = getLedgerRow(walletId, userId, 'bbbb');
		expect(row?.status).toBe('pending');
		expect(row?.confirmed).toBe(false);
		expect(row?.amountSats).toBe(50000);
		expect(alreadyNotified(walletId, userId, 'bbbb')).toBe(false);
	});

	it('trackPendingInbound is idempotent (a second mempool sighting does not disturb the row)', () => {
		trackPendingInbound(walletId, userId, 'cccc', 1000);
		trackPendingInbound(walletId, userId, 'cccc', 999999); // different amount -- must be ignored
		const row = getLedgerRow(walletId, userId, 'cccc');
		expect(row?.amountSats).toBe(1000);
	});

	it('claimReceived transitions a pending row to notified (the mempool->block dedup, SAME row)', () => {
		trackPendingInbound(walletId, userId, 'dddd', 75000);
		const won = withTransaction((db) => claimReceived(db, walletId, userId, 'dddd', 75000, 800000));
		expect(won).toBe(true);
		const row = getLedgerRow(walletId, userId, 'dddd');
		expect(row?.status).toBe('notified');
		expect(row?.confirmed).toBe(true);
		expect(row?.confirmedHeight).toBe(800000);
		expect(alreadyNotified(walletId, userId, 'dddd')).toBe(true);
	});

	it('claimReceived inserts directly as notified for a tx never seen pending (detected straight from a block)', () => {
		const won = withTransaction((db) => claimReceived(db, walletId, userId, 'eeee', 20000, 800001));
		expect(won).toBe(true);
		expect(getLedgerRow(walletId, userId, 'eeee')?.status).toBe('notified');
	});

	it('claimReceived returns false (loses) if the row is already notified -- exactly one winner, no double-fire', () => {
		trackPendingInbound(walletId, userId, 'ffff', 1);
		const first = withTransaction((db) => claimReceived(db, walletId, userId, 'ffff', 1, 800000));
		const second = withTransaction((db) => claimReceived(db, walletId, userId, 'ffff', 1, 800000));
		expect(first).toBe(true);
		expect(second).toBe(false);
	});

	it('claimReceived never re-fires on a baselined (status NULL) row', () => {
		baselineTxids(walletId, userId, ['gggg']);
		const won = withTransaction((db) => claimReceived(db, walletId, userId, 'gggg', 1, 800000));
		expect(won).toBe(false); // WHERE status='pending' does not match NULL
		expect(getLedgerRow(walletId, userId, 'gggg')?.status).toBeNull(); // untouched
	});

	it('baselineTxids records silently (status NULL, confirmed=1) and does not suppress future pending tracking of a DIFFERENT txid', () => {
		baselineTxids(walletId, userId, ['h1', 'h2', 'h3']);
		for (const t of ['h1', 'h2', 'h3']) {
			const row = getLedgerRow(walletId, userId, t);
			expect(row?.status).toBeNull();
			expect(row?.confirmed).toBe(true);
			expect(alreadyNotified(walletId, userId, t)).toBe(true); // baselined suppresses
		}
		trackPendingInbound(walletId, userId, 'h4', 500);
		expect(alreadyNotified(walletId, userId, 'h4')).toBe(false); // a genuinely new pending tx still fires
	});

	it('baselineTxids never downgrades an existing pending row back to a silent baseline', () => {
		trackPendingInbound(walletId, userId, 'i1', 42);
		baselineTxids(walletId, userId, ['i1']); // re-baseline attempt (e.g. a reconnect re-scan)
		const row = getLedgerRow(walletId, userId, 'i1');
		expect(row?.status).toBe('pending'); // untouched by INSERT OR IGNORE
	});

	it('baselineTxids on an empty array is a safe no-op', () => {
		expect(() => baselineTxids(walletId, userId, [])).not.toThrow();
	});

	it('the ledger is keyed per (wallet_id, user_id, txid) -- two different wallets track the same txid independently', () => {
		db2Wallet();
		trackPendingInbound(walletId, userId, 'shared-txid', 100);
		trackPendingInbound(secondWalletId, userId, 'shared-txid', 200);
		expect(getLedgerRow(walletId, userId, 'shared-txid')?.amountSats).toBe(100);
		expect(getLedgerRow(secondWalletId, userId, 'shared-txid')?.amountSats).toBe(200);
	});
});

let secondWalletId: number;
function db2Wallet(): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO wallets (user_id, name, kind, script_type, network, threshold, source) VALUES (?, 'w2', 'single', 'p2wpkh', 'mainnet', 1, 'imported')`
	).run(userId);
	secondWalletId = Number(
		(db.prepare('SELECT id FROM wallets ORDER BY id DESC LIMIT 1').get() as { id: number }).id
	);
}
