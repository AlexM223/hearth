/**
 * Migration 007: the M5 mining engine's tables (DECISIONS.md §4.8,
 * MINING-ENGINE.md §9.3 T0). No new kv table needed for operator settings --
 * `meta` (migration 001, `db/meta.ts`) already serves that role and
 * `mining/settings.ts` reads/writes it directly, matching the household-name
 * settings idiom.
 *
 *  - `mining_prefs`   one row per opted-in user: the permanent miningId token,
 *                     enabled flag, and which of the user's OWN wallets
 *                     receives the full block reward.
 *  - `mining_workers` cumulative per-(user, worker) counters + best-share-ever
 *                     (the trophy baseline) + the last-flushed live snapshot.
 *                     Batch-upserted every 15s (aggregates.ts) -- never a
 *                     per-share write.
 *  - `mining_stats`   one row per CLOSED 1-minute bucket, per-worker AND a
 *                     pool row (user_id/worker_name NULL) -- the admin/public
 *                     hashrate chart series. `round_id` is the ONE dormant,
 *                     nullable seam DECISIONS.md §4.6 mandates for the killed
 *                     coinbase-split payout mode: present, nullable, wired to
 *                     nothing, never read or written by anything in M5.
 *  - `mining_blocks`  every submitblock outcome, accepted or rejected, for the
 *                     dashboard's blocks-found / trophy-wall lists and the
 *                     explorer's pool attribution (M4 seam).
 *
 * Deviation from cairn's schema: `sum_weight`/`best_share_diff`/etc. are
 * native SQLite REAL columns here, not cairn's REAL-cast-through-TEXT dance
 * (`CAST(CAST(sum_weight AS REAL) + ... AS TEXT)`) -- that pattern worked
 * around a better-sqlite3-specific affinity quirk that doesn't apply to
 * node:sqlite; REAL arithmetic in the upsert is simpler and behaves
 * identically for every value this module ever stores (difficulties/hashrates
 * are always well inside float64's exact-integer range for share counts and
 * comfortably precise for the fractional sums involved).
 */
import type { Migration } from '../migrations.js';

export const migration007Mining: Migration = {
	id: 7,
	name: 'mining_prefs/workers/stats/blocks (M5 mining engine)',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS mining_prefs (
				user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
				mining_id         TEXT UNIQUE,
				enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
				payout_wallet_id  INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
				updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);

			CREATE TABLE IF NOT EXISTS mining_workers (
				user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				worker_name      TEXT NOT NULL,
				shares_accepted  INTEGER NOT NULL DEFAULT 0,
				shares_stale     INTEGER NOT NULL DEFAULT 0,
				shares_rejected  INTEGER NOT NULL DEFAULT 0,
				sum_weight       REAL NOT NULL DEFAULT 0,
				best_share_diff  REAL NOT NULL DEFAULT 0,
				hashrate_est     REAL NOT NULL DEFAULT 0,
				current_diff     REAL NOT NULL DEFAULT 0,
				last_share_at    TEXT,
				PRIMARY KEY (user_id, worker_name)
			);

			CREATE TABLE IF NOT EXISTS mining_stats (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				bucket_start TEXT NOT NULL,
				user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
				worker_name  TEXT,
				shares       INTEGER NOT NULL,
				sum_weight   REAL NOT NULL,
				hashrate_est REAL NOT NULL,
				-- Dormant seam (DECISIONS.md §4.6): the killed coinbase-split/payout-
				-- pool mode's round identifier. Nullable, wired to nothing in M5.
				round_id     INTEGER
			);

			CREATE INDEX IF NOT EXISTS idx_mining_stats_pool
				ON mining_stats(bucket_start) WHERE user_id IS NULL;
			CREATE INDEX IF NOT EXISTS idx_mining_stats_user
				ON mining_stats(user_id, bucket_start);

			CREATE TABLE IF NOT EXISTS mining_blocks (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				height               INTEGER NOT NULL,
				block_hash           TEXT NOT NULL UNIQUE,
				coinbase_txid        TEXT,
				user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
				worker_name          TEXT,
				wallet_id            INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
				payout_address       TEXT NOT NULL,
				coinbase_value_sats  INTEGER NOT NULL,
				submit_result        TEXT NOT NULL,
				found_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);

			CREATE INDEX IF NOT EXISTS idx_mining_blocks_height ON mining_blocks(height DESC);
			CREATE INDEX IF NOT EXISTS idx_mining_blocks_user ON mining_blocks(user_id);
		`);
	}
};
