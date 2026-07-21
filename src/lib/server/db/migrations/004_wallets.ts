/**
 * Migration 004: the ONE unified wallet schema (DECISIONS.md §4.8; WALLET-ENGINE
 * §1). Single-sig and multisig share ONE `wallets` table -- `kind` is the only
 * discriminator, `threshold`=1 for single-sig, and keys always live in
 * `wallet_keys` (single-sig = exactly one row). Because there is one wallets
 * table, every child table has a single `wallet_id` FK with ON DELETE CASCADE --
 * no `(wallet_kind, wallet_id)` composites and no hand-written delete triggers
 * (both of which Heartwood's two-table design forced).
 *
 * All amounts are integer sats. Timestamps use the house idiom
 * strftime('%Y-%m-%dT%H:%M:%fZ','now'). Idempotent CREATE TABLE IF NOT EXISTS.
 */
import type { Migration } from '../migrations.js';

export const migration004Wallets: Migration = {
	id: 4,
	name: 'wallets (one unified engine)',
	up(db) {
		db.exec(`
			-- ============================ wallets ============================
			CREATE TABLE IF NOT EXISTS wallets (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				name            TEXT    NOT NULL,
				kind            TEXT    NOT NULL CHECK (kind IN ('single','multisig')),
				script_type     TEXT    NOT NULL,
				network         TEXT    NOT NULL DEFAULT 'mainnet'
									CHECK (network IN ('mainnet','testnet','regtest')),
				threshold       INTEGER NOT NULL DEFAULT 1,
				descriptor      TEXT,
				receive_cursor  INTEGER NOT NULL DEFAULT 0,
				change_cursor   INTEGER NOT NULL DEFAULT 0,
				source          TEXT    NOT NULL DEFAULT 'imported'
									CHECK (source IN ('created','imported')),
				watch_only      INTEGER NOT NULL DEFAULT 1,
				created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			);
			CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

			-- ============================ wallet_keys ============================
			CREATE TABLE IF NOT EXISTS wallet_keys (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id        INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				position         INTEGER NOT NULL,
				name             TEXT,
				category         TEXT,
				device_type      TEXT,
				xpub             TEXT NOT NULL,
				fingerprint      TEXT NOT NULL,
				path             TEXT NOT NULL,
				assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
				last_verified_at TEXT,
				UNIQUE (wallet_id, position),
				UNIQUE (wallet_id, xpub)
			);
			CREATE INDEX IF NOT EXISTS idx_wallet_keys_wallet ON wallet_keys(wallet_id);

			-- ============================ addresses ============================
			CREATE TABLE IF NOT EXISTS addresses (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id         INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				chain             INTEGER NOT NULL CHECK (chain IN (0,1)),
				address_index     INTEGER NOT NULL,
				address           TEXT    NOT NULL,
				scripthash        TEXT    NOT NULL,
				script_pubkey     TEXT    NOT NULL,
				used              INTEGER NOT NULL DEFAULT 0,
				first_seen_height INTEGER,
				UNIQUE (wallet_id, chain, address_index)
			);
			CREATE INDEX IF NOT EXISTS idx_addresses_wallet ON addresses(wallet_id, chain, address_index);
			CREATE INDEX IF NOT EXISTS idx_addresses_scripthash ON addresses(scripthash);

			-- ============================ utxos ============================
			CREATE TABLE IF NOT EXISTS utxos (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id            INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				txid                 TEXT    NOT NULL,
				vout                 INTEGER NOT NULL,
				value_sats           INTEGER NOT NULL,
				chain                INTEGER NOT NULL,
				address_index        INTEGER NOT NULL,
				address              TEXT    NOT NULL,
				height               INTEGER NOT NULL DEFAULT 0,
				coinbase             INTEGER NOT NULL DEFAULT 0,
				unconfirmed_trust    TEXT,
				reserved_by_draft_id INTEGER,
				UNIQUE (wallet_id, txid, vout)
			);
			CREATE INDEX IF NOT EXISTS idx_utxos_wallet ON utxos(wallet_id);

			-- ============================ transactions ============================
			CREATE TABLE IF NOT EXISTS transactions (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id   INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				txid        TEXT    NOT NULL,
				height      INTEGER NOT NULL DEFAULT 0,
				block_time  INTEGER,
				delta_sats  INTEGER NOT NULL,
				fee_sats    INTEGER,
				UNIQUE (wallet_id, txid)
			);
			CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);

			-- ============================ psbt_drafts ============================
			CREATE TABLE IF NOT EXISTS psbt_drafts (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id            INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				status               TEXT    NOT NULL DEFAULT 'draft'
										CHECK (status IN ('draft','signing','broadcast','confirmed','abandoned','superseded')),
				psbt                 TEXT    NOT NULL,
				txid                 TEXT,
				recipients           TEXT    NOT NULL,
				amount_sats          INTEGER NOT NULL,
				fee_sats             INTEGER NOT NULL,
				fee_rate             REAL    NOT NULL,
				change_index         INTEGER,
				replaces_txid        TEXT,
				broadcast_started_at TEXT,
				created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				expires_at           TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_psbt_drafts_wallet ON psbt_drafts(wallet_id, status);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_psbt_drafts_replaces
				ON psbt_drafts(wallet_id, replaces_txid) WHERE replaces_txid IS NOT NULL;

			-- ============================ psbt_draft_inputs ============================
			CREATE TABLE IF NOT EXISTS psbt_draft_inputs (
				draft_id   INTEGER NOT NULL REFERENCES psbt_drafts(id) ON DELETE CASCADE,
				txid       TEXT    NOT NULL,
				vout       INTEGER NOT NULL,
				value_sats INTEGER NOT NULL,
				PRIMARY KEY (draft_id, txid, vout)
			);
			CREATE INDEX IF NOT EXISTS idx_psbt_draft_inputs_outpoint ON psbt_draft_inputs(txid, vout);

			-- ============================ psbt_draft_signers ============================
			CREATE TABLE IF NOT EXISTS psbt_draft_signers (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				draft_id         INTEGER NOT NULL REFERENCES psbt_drafts(id) ON DELETE CASCADE,
				user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				assigned_key_ids TEXT    NOT NULL,
				has_signed       INTEGER NOT NULL DEFAULT 0,
				signed_at        TEXT,
				UNIQUE (draft_id, user_id)
			);

			-- ==================== SWR render cache (§4.5) ====================
			CREATE TABLE IF NOT EXISTS wallet_snapshots (
				wallet_id      INTEGER PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
				snapshot       TEXT    NOT NULL,
				summary        TEXT,
				last_synced_at INTEGER NOT NULL,
				dirty_since    INTEGER
			);

			CREATE TABLE IF NOT EXISTS scripthash_status (
				wallet_id  INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				scripthash TEXT    NOT NULL,
				status     TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (wallet_id, scripthash)
			);

			-- ============ Optional multisig-only Ledger BIP-388 registration ============
			CREATE TABLE IF NOT EXISTS ledger_wallet_registrations (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_id   INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				master_fp   TEXT NOT NULL,
				policy_name TEXT NOT NULL,
				policy_hmac TEXT NOT NULL,
				created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				UNIQUE (wallet_id, master_fp)
			);
		`);
	}
};
