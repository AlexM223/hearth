/**
 * The `notified_txids` dedup ledger (WATCHTOWER.md §1.7). One notification
 * chain per tx, keyed (wallet_id, user_id, txid) -- NOT by confirmation count
 * or scripthash. This is the ONLY module that writes this table; detect/
 * watcher.ts and detect/confirm.ts call through here rather than issuing
 * their own SQL, so the dedup invariants (atomic claim, baseline-is-silent,
 * pending-never-suppresses) live in exactly one place.
 *
 * Status vocabulary: NULL (baselined/legacy silent record) | 'pending'
 * (unconfirmed inbound, tracked only) | 'notified' (tx_received fired) |
 * 'replaced' | 'dropped' (terminal, T2/confirm.ts).
 */
import { getDb, withTransaction } from '../../db/index.js';
import type { DatabaseSync } from 'node:sqlite';

export interface NotifiedTxidRow {
	walletId: number;
	userId: number;
	txid: string;
	status: 'pending' | 'notified' | 'replaced' | 'dropped' | null;
	confirmed: boolean;
	confirmedHeight: number | null;
	amountSats: number | null;
	lastMilestone: number;
}

interface RawRow {
	wallet_id: number;
	user_id: number;
	txid: string;
	status: string | null;
	confirmed: number;
	confirmed_height: number | null;
	amount_sats: number | null;
	last_milestone: number;
}

function toRow(r: RawRow): NotifiedTxidRow {
	return {
		walletId: r.wallet_id,
		userId: r.user_id,
		txid: r.txid,
		status: r.status as NotifiedTxidRow['status'],
		confirmed: r.confirmed === 1,
		confirmedHeight: r.confirmed_height,
		amountSats: r.amount_sats,
		lastMilestone: r.last_milestone
	};
}

/** The raw row, or null if this (wallet,user,txid) has never been recorded. */
export function getLedgerRow(walletId: number, userId: number, txid: string): NotifiedTxidRow | null {
	const row = getDb()
		.prepare(
			`SELECT wallet_id, user_id, txid, status, confirmed, confirmed_height, amount_sats, last_milestone
			 FROM notified_txids WHERE wallet_id = ? AND user_id = ? AND txid = ?`
		)
		.get(walletId, userId, txid) as unknown as RawRow | undefined;
	return row ? toRow(row) : null;
}

/**
 * A `'pending'` row is treated as NOT YET notified (it must still fire once
 * confirmed) -- every other row (NULL/'notified'/'replaced'/'dropped')
 * suppresses a fresh tx_received (WATCHTOWER.md §1.7 table).
 */
export function alreadyNotified(walletId: number, userId: number, txid: string): boolean {
	const row = getLedgerRow(walletId, userId, txid);
	return row !== null && row.status !== 'pending';
}

/**
 * Record a mempool sighting as tracked-only (never surfaced as "received"
 * itself). Idempotent -- a tx seen again in the mempool before it confirms
 * must not disturb an existing row (INSERT OR IGNORE).
 */
export function trackPendingInbound(
	walletId: number,
	userId: number,
	txid: string,
	amountSats: number
): void {
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO notified_txids (wallet_id, user_id, txid, status, confirmed, amount_sats)
			 VALUES (?, ?, ?, 'pending', 0, ?)`
		)
		.run(walletId, userId, txid, amountSats);
}

/**
 * The atomic mempool->block dedup claim (WATCHTOWER.md §1.5, §1.7): a tx
 * first seen in mempool is a 'pending' row; confirmation transitions that
 * SAME row to 'notified' (never a second row). A brand-new confirmed tx
 * (never seen pending -- e.g. detected straight from a block) inserts
 * directly as 'notified'. Returns true iff THIS call is the one that made the
 * row 'notified' (changes>0) -- exactly one concurrent caller wins; losers
 * suppress. Must run inside the SAME transaction as the in-app events write
 * (dispatch.ts, T3) so a crash between claim and record can never silently
 * lose a payment notification (cairn-fzqpe).
 */
export function claimReceived(
	db: DatabaseSync,
	walletId: number,
	userId: number,
	txid: string,
	amountSats: number,
	confirmedHeight: number
): boolean {
	const res = db
		.prepare(
			`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed, confirmed_height, amount_sats)
			 VALUES (?, ?, ?, 'notified', 1, ?, ?)
			 ON CONFLICT(wallet_id, user_id, txid) DO UPDATE SET
			   status = 'notified',
			   confirmed = 1,
			   confirmed_height = excluded.confirmed_height,
			   amount_sats = COALESCE(excluded.amount_sats, notified_txids.amount_sats),
			   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE notified_txids.status = 'pending'`
		)
		.run(walletId, userId, txid, confirmedHeight, amountSats);
	return Number(res.changes) > 0;
}

/**
 * The anti-flood mechanism (WATCHTOWER.md §1.1 step 4, cairn-u7bw/-3bt1):
 * silently record every txid a never-before-seen scripthash's history already
 * contains, so a first subscription (or a post-reconnect re-baseline) never
 * floods pre-existing activity as fresh "payment received" events.
 * INSERT OR IGNORE -- a txid already tracked (e.g. genuinely pending) is left
 * untouched, never downgraded back to a silent baseline row.
 */
export function baselineTxids(walletId: number, userId: number, txids: string[]): void {
	if (txids.length === 0) return;
	withTransaction((db) => {
		const stmt = db.prepare(
			`INSERT OR IGNORE INTO notified_txids (wallet_id, user_id, txid, status, confirmed)
			 VALUES (?, ?, ?, NULL, 1)`
		);
		for (const txid of txids) stmt.run(walletId, userId, txid);
	});
}
