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
 *
 * Sets `last_milestone = 1` unconditionally: firing `tx_received` IS the
 * CONFIRM_THRESHOLD=1 milestone (WATCHTOWER.md §1.6, "default routing fires
 * only the 1-conf milestone"). detect/confirm.ts's milestone progression
 * (T2) only ever needs to look for a NEXT milestone strictly greater than
 * this.
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
			`INSERT INTO notified_txids (wallet_id, user_id, txid, status, confirmed, confirmed_height, amount_sats, last_milestone)
			 VALUES (?, ?, ?, 'notified', 1, ?, ?, 1)
			 ON CONFLICT(wallet_id, user_id, txid) DO UPDATE SET
			   status = 'notified',
			   confirmed = 1,
			   confirmed_height = excluded.confirmed_height,
			   amount_sats = COALESCE(excluded.amount_sats, notified_txids.amount_sats),
			   last_milestone = 1,
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

// --------------------------------------------------------- T2: confirm.ts

/** The "not-yet-confirmed" population (WATCHTOWER.md §1.6 step 1): a
 *  'pending' row is the only status this can ever match under this schema
 *  (claimReceived always sets confirmed=1 together with status='notified',
 *  so a 'notified' row is never confirmed=0 here) -- confirm.ts uses this
 *  population ONLY to notice a mempool tx vanishing before it ever
 *  confirmed (reconcileDisappeared's "never confirmed" wording); the actual
 *  0->1-conf transition is watcher.ts's job (a scripthash status-change
 *  event), not a block event. */
export function selectUnconfirmedRows(): NotifiedTxidRow[] {
	const rows = getDb()
		.prepare(
			`SELECT wallet_id, user_id, txid, status, confirmed, confirmed_height, amount_sats, last_milestone
			 FROM notified_txids WHERE confirmed = 0 AND status = 'pending'`
		)
		.all() as unknown as RawRow[];
	return rows.map(toRow);
}

/** The reorg-recheck population (WATCHTOWER.md §1.6 step 1): confirmed,
 *  notified rows whose confirmed_height is still within REORG_RECHECK_DEPTH
 *  of the tip -- both reorg detection AND further milestone (3/6-conf)
 *  progression are evaluated against this population (confirm.ts). Rows
 *  with `confirmed_height IS NULL` (baselined/legacy) are never re-checked. */
export function selectReorgWindowRows(tipHeight: number, depth: number): NotifiedTxidRow[] {
	const rows = getDb()
		.prepare(
			`SELECT wallet_id, user_id, txid, status, confirmed, confirmed_height, amount_sats, last_milestone
			 FROM notified_txids
			 WHERE confirmed = 1 AND status = 'notified' AND confirmed_height IS NOT NULL AND confirmed_height > ?`
		)
		.all(tipHeight - depth) as unknown as RawRow[];
	return rows.map(toRow);
}

/** Advance a row's milestone marker -- fires at most once per milestone
 *  (dedup key (txid,milestone) collapses to "milestone > last_milestone",
 *  enforced by the WHERE clause). Returns true iff THIS call advanced it. */
export function markMilestone(
	walletId: number,
	userId: number,
	txid: string,
	milestone: number,
	confirmedHeight: number
): boolean {
	const res = getDb()
		.prepare(
			`UPDATE notified_txids
			 SET last_milestone = ?, confirmed_height = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE wallet_id = ? AND user_id = ? AND txid = ? AND last_milestone < ?`
		)
		.run(milestone, confirmedHeight, walletId, userId, txid, milestone);
	return Number(res.changes) > 0;
}

/** Terminal transition: a confirmed/pending inbound tx vanished from the
 *  chain and the user is told (a real reversal/cancellation, never silent).
 *  Only transitions from 'pending' or 'notified' -- already-terminal rows
 *  ('replaced'/'dropped') are left alone (idempotent). */
export function markReplaced(walletId: number, userId: number, txid: string): boolean {
	const res = getDb()
		.prepare(
			`UPDATE notified_txids SET status = 'replaced', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE wallet_id = ? AND user_id = ? AND txid = ? AND status IN ('pending', 'notified')`
		)
		.run(walletId, userId, txid);
	return Number(res.changes) > 0;
}

/** Terminal transition: a confirmed/pending inbound tx vanished silently
 *  (change output / own-spend / an RBF fee-bump replacement) -- no
 *  notification fires, but it stops being re-checked forever. */
export function markDropped(walletId: number, userId: number, txid: string): boolean {
	const res = getDb()
		.prepare(
			`UPDATE notified_txids SET status = 'dropped', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE wallet_id = ? AND user_id = ? AND txid = ? AND status IN ('pending', 'notified')`
		)
		.run(walletId, userId, txid);
	return Number(res.changes) > 0;
}
