/**
 * T0 acceptance (WALLET-ENGINE §7): migration 004 applies idempotently on a
 * fresh AND an existing DB; the SWR cache tables carry a single `wallet_id` FK
 * (no `(wallet_kind, wallet_id)` composite -- the whole point of the one-table
 * unification); the kind/network CHECK constraints hold; child rows cascade on
 * wallet delete (no hand-written triggers needed).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations.js';

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	return db;
}

function makeUser(db: DatabaseSync): number {
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
		'alex',
		'hash',
		'owner'
	);
	return Number((db.prepare('SELECT id FROM users WHERE username = ?').get('alex') as { id: number }).id);
}

describe('migration 004: unified wallet schema', () => {
	it('creates every wallet table', () => {
		const db = freshDb();
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
		).map((t) => t.name);
		for (const t of [
			'wallets',
			'wallet_keys',
			'addresses',
			'utxos',
			'transactions',
			'psbt_drafts',
			'psbt_draft_inputs',
			'psbt_draft_signers',
			'wallet_snapshots',
			'scripthash_status',
			'ledger_wallet_registrations'
		]) {
			expect(names).toContain(t);
		}
	});

	it('is idempotent -- re-running migrations on an existing DB never throws', () => {
		const db = freshDb();
		expect(() => runMigrations(db)).not.toThrow();
	});

	it('wallet_snapshots is keyed by a single wallet_id (no composite key)', () => {
		const db = freshDb();
		const cols = db.prepare('PRAGMA table_info(wallet_snapshots)').all() as {
			name: string;
			pk: number;
		}[];
		const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
		expect(pkCols).toEqual(['wallet_id']);
		expect(cols.map((c) => c.name)).not.toContain('wallet_kind');
	});

	it('scripthash_status has no wallet_kind column (single wallet_id FK)', () => {
		const db = freshDb();
		const cols = (db.prepare('PRAGMA table_info(scripthash_status)').all() as { name: string }[]).map(
			(c) => c.name
		);
		expect(cols).not.toContain('wallet_kind');
		expect(cols).toContain('wallet_id');
	});

	it('enforces the kind CHECK constraint', () => {
		const db = freshDb();
		const userId = makeUser(db);
		expect(() =>
			db
				.prepare(
					'INSERT INTO wallets (user_id, name, kind, script_type) VALUES (?, ?, ?, ?)'
				)
				.run(userId, 'w', 'single', 'p2wpkh')
		).not.toThrow();
		expect(() =>
			db
				.prepare('INSERT INTO wallets (user_id, name, kind, script_type) VALUES (?, ?, ?, ?)')
				.run(userId, 'w2', 'quantum', 'p2wpkh')
		).toThrow();
	});

	it('cascades child rows on wallet delete without any trigger', () => {
		const db = freshDb();
		const userId = makeUser(db);
		db.prepare('INSERT INTO wallets (user_id, name, kind, script_type) VALUES (?, ?, ?, ?)').run(
			userId,
			'w',
			'single',
			'p2wpkh'
		);
		const walletId = Number(
			(db.prepare('SELECT id FROM wallets').get() as { id: number }).id
		);
		db.prepare(
			'INSERT INTO wallet_keys (wallet_id, position, xpub, fingerprint, path) VALUES (?, ?, ?, ?, ?)'
		).run(walletId, 0, 'xpub...', '00000000', "m/84'/0'/0'");
		db.prepare(
			'INSERT INTO addresses (wallet_id, chain, address_index, address, scripthash, script_pubkey) VALUES (?,?,?,?,?,?)'
		).run(walletId, 0, 0, 'bc1qaddr', 'sh', '0014deadbeef');

		db.prepare('DELETE FROM wallets WHERE id = ?').run(walletId);
		expect((db.prepare('SELECT COUNT(*) c FROM wallet_keys').get() as { c: number }).c).toBe(0);
		expect((db.prepare('SELECT COUNT(*) c FROM addresses').get() as { c: number }).c).toBe(0);
	});

	it('the RBF partial-unique index allows many NULL replaces_txid but one live replacement', () => {
		const db = freshDb();
		const userId = makeUser(db);
		db.prepare('INSERT INTO wallets (user_id, name, kind, script_type) VALUES (?, ?, ?, ?)').run(
			userId,
			'w',
			'single',
			'p2wpkh'
		);
		const walletId = Number((db.prepare('SELECT id FROM wallets').get() as { id: number }).id);
		const ins = (replaces: string | null) =>
			db
				.prepare(
					`INSERT INTO psbt_drafts (wallet_id, created_by, psbt, recipients, amount_sats, fee_sats, fee_rate, replaces_txid, expires_at)
					 VALUES (?, ?, 'psbt', '[]', 0, 0, 1, ?, '2099-01-01T00:00:00.000Z')`
				)
				.run(walletId, userId, replaces);
		// Two NULL replaces are fine (ordinary sends).
		expect(() => {
			ins(null);
			ins(null);
		}).not.toThrow();
		// First replacement of a given txid is fine; a second collides.
		expect(() => ins('abc123')).not.toThrow();
		expect(() => ins('abc123')).toThrow();
	});
});
