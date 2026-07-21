/**
 * Migration 008: the M6 watchtower's tables (DECISIONS.md §4.8/§4.9,
 * WATCHTOWER.md §1.7/§2.7/§5.1).
 *
 *  - `notified_txids`               the dedup ledger: one notification chain
 *                                    per (wallet_id, user_id, txid), never per
 *                                    confirmation count or scripthash
 *                                    (WATCHTOWER.md §1.7). `status` is
 *                                    nullable -- NULL means a silently
 *                                    baselined/legacy row that must never fire
 *                                    a notification. `last_milestone` is the
 *                                    highest confirmation milestone (1/3/6)
 *                                    already fired for this tx, so a milestone
 *                                    fires at most once (dedup key (txid,
 *                                    milestone) collapses to "milestone >
 *                                    last_milestone").
 *  - `notification_queue`           the outbox: durable retry/backoff queue
 *                                    for the five external channels (never
 *                                    'inapp', which is written inline).
 *  - `notification_preferences`     per-user × event-type × channel routing
 *                                    (+ per-type config JSON: thresholds,
 *                                    confirmation milestones).
 *  - `notification_channel_config`  per-user × channel connection config;
 *                                    secret fields inside the JSON are
 *                                    AES-256-GCM envelopes (`secrets.ts`).
 *  - `instance_secrets`             instance-wide notify secrets (bot token,
 *                                    SMTP relay password, the Nostr sender
 *                                    identity), same envelope scheme.
 *
 * Non-secret instance-wide settings (smtp_host/port/user/from/tls,
 * ntfy_default_server, nostr_default_relays, webhook_allow_private_targets)
 * reuse the existing `meta` kv table (migration 001) -- no new table needed
 * for those, matching the household-settings idiom migration 007 already
 * established for mining.
 */
import type { Migration } from '../migrations.js';

export const migration008Notify: Migration = {
	id: 8,
	name: 'notified_txids/notification_queue/notification_preferences/notification_channel_config/instance_secrets (M6 watchtower)',
	up(db) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS notified_txids (
				wallet_id        INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
				user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				txid             TEXT NOT NULL,
				status           TEXT CHECK (status IS NULL OR status IN ('pending', 'notified', 'replaced', 'dropped')),
				confirmed        INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
				confirmed_height INTEGER,
				amount_sats      INTEGER,
				last_milestone   INTEGER NOT NULL DEFAULT 0,
				created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				PRIMARY KEY (wallet_id, user_id, txid)
			);

			-- handleScripthashChange's per-tx dedup lookup (WATCHTOWER.md §1.1 step 6).
			CREATE INDEX IF NOT EXISTS idx_notified_txids_txid ON notified_txids(txid);
			-- confirm.ts's two re-scan populations (WATCHTOWER.md §1.6 step 1).
			CREATE INDEX IF NOT EXISTS idx_notified_txids_unconfirmed
				ON notified_txids(confirmed, status) WHERE confirmed = 0 AND status IN ('pending', 'notified');
			CREATE INDEX IF NOT EXISTS idx_notified_txids_reorg_window
				ON notified_txids(confirmed, status, confirmed_height) WHERE confirmed = 1 AND status = 'notified';

			CREATE TABLE IF NOT EXISTS notification_queue (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				channel         TEXT    NOT NULL,      -- external channel id (never 'inapp')
				event_type      TEXT    NOT NULL,
				payload         TEXT    NOT NULL,      -- serialized NotificationPayload; carries NO secrets
				status          TEXT    NOT NULL DEFAULT 'pending'
				                  CHECK (status IN ('pending', 'sent', 'failed', 'dead')),
				attempts        INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				last_error      TEXT,
				sent_at         TEXT,
				created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);
			CREATE INDEX IF NOT EXISTS idx_notification_queue_due
				ON notification_queue(status, next_attempt_at);

			CREATE TABLE IF NOT EXISTS notification_preferences (
				user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				event_type  TEXT    NOT NULL,
				channel     TEXT    NOT NULL,
				enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
				config      TEXT,
				PRIMARY KEY (user_id, event_type, channel)
			);

			CREATE TABLE IF NOT EXISTS notification_channel_config (
				user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				channel  TEXT    NOT NULL,
				config   TEXT    NOT NULL,
				PRIMARY KEY (user_id, channel)
			);

			CREATE TABLE IF NOT EXISTS instance_secrets (
				key       TEXT PRIMARY KEY,
				value_enc TEXT NOT NULL
			);
		`);
	}
};
