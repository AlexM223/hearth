/**
 * All wallet-engine SQL (WALLET-ENGINE §0.3). node:sqlite, synchronous, no ORM.
 * ONE wallets/wallet_keys/addresses/utxos/transactions/psbt_drafts schema --
 * kind is a column, never a second table. Every function is kind-blind.
 *
 * Discipline (DECISIONS.md §2): callers precompute async work before opening a
 * transaction; these helpers are synchronous and safe inside withTransaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getDb, withTransaction } from '../db/index.js';
import type {
	ChainNetwork,
	CosignerKey,
	DraftRow,
	DraftStatus,
	ScriptType,
	Wallet,
	WalletKind
} from './types.js';

// ------------------------------------------------------------------- row types

interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	kind: WalletKind;
	script_type: ScriptType;
	network: ChainNetwork;
	threshold: number;
	descriptor: string | null;
	receive_cursor: number;
	change_cursor: number;
	source: 'created' | 'imported';
	created_at: string;
}

interface WalletKeyRow {
	position: number;
	name: string | null;
	category: string | null;
	device_type: string | null;
	xpub: string;
	fingerprint: string;
	path: string;
	assigned_user_id: number | null;
}

// ------------------------------------------------------------------ hydration

function hydrateKey(row: WalletKeyRow): CosignerKey {
	return {
		position: row.position,
		xpub: row.xpub,
		fingerprint: row.fingerprint,
		path: row.path,
		name: row.name ?? undefined,
		category: row.category ?? undefined,
		deviceType: row.device_type,
		assignedUserId: row.assigned_user_id
	};
}

function hydrateWallet(row: WalletRow, keys: CosignerKey[]): Wallet {
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		kind: row.kind,
		scriptType: row.script_type,
		network: row.network,
		threshold: row.threshold,
		descriptor: row.descriptor,
		receiveCursor: row.receive_cursor,
		changeCursor: row.change_cursor,
		source: row.source,
		keys,
		createdAt: row.created_at
	};
}

// --------------------------------------------------------------- wallet writes

export interface NewWallet {
	userId: number;
	name: string;
	kind: WalletKind;
	scriptType: ScriptType;
	network: ChainNetwork;
	threshold: number;
	descriptor: string | null;
	source: 'created' | 'imported';
	keys: Array<{
		position: number;
		xpub: string;
		fingerprint: string;
		path: string;
		name?: string | null;
		category?: string | null;
		deviceType?: string | null;
		assignedUserId?: number | null;
	}>;
}

/** Persist a wallet + its keys atomically. Returns the new wallet id. */
export function insertWallet(input: NewWallet): number {
	return withTransaction((db) => {
		const res = db
			.prepare(
				`INSERT INTO wallets (user_id, name, kind, script_type, network, threshold, descriptor, source)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.userId,
				input.name,
				input.kind,
				input.scriptType,
				input.network,
				input.threshold,
				input.descriptor,
				input.source
			);
		const walletId = Number(res.lastInsertRowid);
		const insKey = db.prepare(
			`INSERT INTO wallet_keys (wallet_id, position, name, category, device_type, xpub, fingerprint, path, assigned_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const k of input.keys) {
			insKey.run(
				walletId,
				k.position,
				k.name ?? null,
				k.category ?? null,
				k.deviceType ?? null,
				k.xpub,
				k.fingerprint,
				k.path,
				k.assignedUserId ?? null
			);
		}
		return walletId;
	});
}

// --------------------------------------------------------------- wallet reads

function loadKeys(db: DatabaseSync, walletId: number): CosignerKey[] {
	const rows = db
		.prepare(
			`SELECT position, name, category, device_type, xpub, fingerprint, path, assigned_user_id
			 FROM wallet_keys WHERE wallet_id = ? ORDER BY position ASC`
		)
		.all(walletId) as unknown as WalletKeyRow[];
	return rows.map(hydrateKey);
}

/** Fetch a wallet scoped to its owner (ownership gate). Null if absent/foreign. */
export function getWalletRow(userId: number, walletId: number): Wallet | null {
	const db = getDb();
	const row = db
		.prepare('SELECT * FROM wallets WHERE id = ? AND user_id = ?')
		.get(walletId, userId) as WalletRow | undefined;
	if (!row) return null;
	return hydrateWallet(row, loadKeys(db, walletId));
}

/** Fetch a wallet by id WITHOUT the owner scope -- for internal engine use only
 *  (sync/scan/broadcast already resolved authorization). Never call from a route
 *  without a role check. */
export function getWalletRowUnscoped(walletId: number): Wallet | null {
	const db = getDb();
	const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId) as
		| WalletRow
		| undefined;
	if (!row) return null;
	return hydrateWallet(row, loadKeys(db, walletId));
}

export function listWalletRows(userId: number): Wallet[] {
	const db = getDb();
	const rows = db
		.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY id ASC')
		.all(userId) as unknown as WalletRow[];
	return rows.map((row) => hydrateWallet(row, loadKeys(db, row.id)));
}

export function deleteWalletRow(userId: number, walletId: number): boolean {
	const db = getDb();
	const res = db.prepare('DELETE FROM wallets WHERE id = ? AND user_id = ?').run(walletId, userId);
	return Number(res.changes) > 0;
}

/** Advance the receive/change cursors (after a scan or a receive rotation). */
export function updateCursors(walletId: number, receiveCursor: number, changeCursor: number): void {
	getDb()
		.prepare('UPDATE wallets SET receive_cursor = ?, change_cursor = ? WHERE id = ?')
		.run(receiveCursor, changeCursor, walletId);
}

// --------------------------------------------------------------- draft reads
// (writes land with the build/broadcast steps; these reads are shared.)

interface DraftDbRow {
	id: number;
	wallet_id: number;
	created_by: number;
	status: DraftStatus;
	psbt: string;
	txid: string | null;
	recipients: string;
	amount_sats: number;
	fee_sats: number;
	fee_rate: number;
	change_index: number | null;
	replaces_txid: string | null;
	broadcast_started_at: string | null;
	created_at: string;
	updated_at: string;
	expires_at: string;
}

export function hydrateDraft(row: DraftDbRow): DraftRow {
	return {
		id: row.id,
		walletId: row.wallet_id,
		createdBy: row.created_by,
		status: row.status,
		psbt: row.psbt,
		txid: row.txid,
		recipients: JSON.parse(row.recipients),
		amountSats: row.amount_sats,
		feeSats: row.fee_sats,
		feeRate: row.fee_rate,
		changeIndex: row.change_index,
		replacesTxid: row.replaces_txid,
		broadcastStartedAt: row.broadcast_started_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at
	};
}

export function getDraftRow(walletId: number, draftId: number): DraftRow | null {
	const row = getDb()
		.prepare('SELECT * FROM psbt_drafts WHERE id = ? AND wallet_id = ?')
		.get(draftId, walletId) as DraftDbRow | undefined;
	return row ? hydrateDraft(row) : null;
}

export function listDraftRows(walletId: number): DraftRow[] {
	const rows = getDb()
		.prepare('SELECT * FROM psbt_drafts WHERE wallet_id = ? ORDER BY id DESC')
		.all(walletId) as unknown as DraftDbRow[];
	return rows.map(hydrateDraft);
}

// -------------------------------------------------- scan/snapshot persistence

export interface PersistAddress {
	chain: 0 | 1;
	index: number;
	address: string;
	scripthash: string;
	scriptPubKey: string;
	used: boolean;
	firstSeenHeight: number | null;
}
export interface PersistUtxo {
	txid: string;
	vout: number;
	valueSats: number;
	chain: 0 | 1;
	index: number;
	address: string;
	height: number;
	coinbase: boolean;
	unconfirmedTrust: 'own-change' | 'received' | null;
}
export interface PersistTx {
	txid: string;
	height: number;
	blockTime: number | null;
	deltaSats: number;
	feeSats: number | null;
}

/** Atomically replace a wallet's scan-derived rows + snapshot (wipe-safe cache).
 *  All rows are rewritten in one transaction so a reader never sees a torn scan. */
export function persistScan(
	walletId: number,
	data: {
		addresses: PersistAddress[];
		utxos: PersistUtxo[];
		transactions: PersistTx[];
		snapshotJson: string;
		summaryJson: string | null;
		receiveCursor: number;
		changeCursor: number;
		lastSyncedAtMs: number;
	}
): void {
	withTransaction((db) => {
		db.prepare('DELETE FROM addresses WHERE wallet_id = ?').run(walletId);
		db.prepare('DELETE FROM utxos WHERE wallet_id = ?').run(walletId);
		db.prepare('DELETE FROM transactions WHERE wallet_id = ?').run(walletId);

		const insAddr = db.prepare(
			`INSERT INTO addresses (wallet_id, chain, address_index, address, scripthash, script_pubkey, used, first_seen_height)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const a of data.addresses) {
			insAddr.run(
				walletId,
				a.chain,
				a.index,
				a.address,
				a.scripthash,
				a.scriptPubKey,
				a.used ? 1 : 0,
				a.firstSeenHeight
			);
		}
		const insUtxo = db.prepare(
			`INSERT INTO utxos (wallet_id, txid, vout, value_sats, chain, address_index, address, height, coinbase, unconfirmed_trust)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const u of data.utxos) {
			insUtxo.run(
				walletId,
				u.txid,
				u.vout,
				u.valueSats,
				u.chain,
				u.index,
				u.address,
				u.height,
				u.coinbase ? 1 : 0,
				u.unconfirmedTrust
			);
		}
		const insTx = db.prepare(
			`INSERT INTO transactions (wallet_id, txid, height, block_time, delta_sats, fee_sats)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		for (const t of data.transactions) {
			insTx.run(walletId, t.txid, t.height, t.blockTime, t.deltaSats, t.feeSats);
		}

		db.prepare('UPDATE wallets SET receive_cursor = ?, change_cursor = ? WHERE id = ?').run(
			data.receiveCursor,
			data.changeCursor,
			walletId
		);
		db.prepare(
			`INSERT INTO wallet_snapshots (wallet_id, snapshot, summary, last_synced_at, dirty_since)
			 VALUES (?, ?, ?, ?, NULL)
			 ON CONFLICT(wallet_id) DO UPDATE SET snapshot = excluded.snapshot,
			   summary = excluded.summary, last_synced_at = excluded.last_synced_at, dirty_since = NULL`
		).run(walletId, data.snapshotJson, data.summaryJson, data.lastSyncedAtMs);
		return null;
	});
}

interface SnapshotRow {
	snapshot: string;
	summary: string | null;
	last_synced_at: number;
	dirty_since: number | null;
}

export function readSnapshotRow(
	walletId: number
): { snapshot: unknown; summary: unknown; lastSyncedAt: number; dirtySince: number | null } | null {
	const row = getDb()
		.prepare('SELECT snapshot, summary, last_synced_at, dirty_since FROM wallet_snapshots WHERE wallet_id = ?')
		.get(walletId) as SnapshotRow | undefined;
	if (!row) return null;
	return {
		snapshot: JSON.parse(row.snapshot),
		summary: row.summary ? JSON.parse(row.summary) : null,
		lastSyncedAt: row.last_synced_at,
		dirtySince: row.dirty_since
	};
}

/** Mark a wallet's snapshot dirty (a subscribed scripthash changed). Idempotent. */
export function markSnapshotDirty(walletId: number, ms: number): void {
	getDb()
		.prepare(
			'UPDATE wallet_snapshots SET dirty_since = ? WHERE wallet_id = ? AND dirty_since IS NULL'
		)
		.run(ms, walletId);
}

interface UtxoDbRow {
	txid: string;
	vout: number;
	value_sats: number;
	chain: 0 | 1;
	address_index: number;
	address: string;
	height: number;
	coinbase: number;
	unconfirmed_trust: string | null;
}

/** Cached UTXOs (SWR view). The SEND path re-scans live and never trusts this. */
export function getUtxoRows(walletId: number): UtxoDbRow[] {
	return getDb()
		.prepare('SELECT * FROM utxos WHERE wallet_id = ? ORDER BY value_sats DESC')
		.all(walletId) as unknown as UtxoDbRow[];
}

interface TxDbRow {
	txid: string;
	height: number;
	block_time: number | null;
	delta_sats: number;
	fee_sats: number | null;
}
export function getTransactionRows(walletId: number, limit = 50): TxDbRow[] {
	return getDb()
		.prepare(
			'SELECT txid, height, block_time, delta_sats, fee_sats FROM transactions WHERE wallet_id = ? ORDER BY (height = 0) DESC, height DESC LIMIT ?'
		)
		.all(walletId, limit) as unknown as TxDbRow[];
}

// -------------------------------------------------------------- draft writes

export interface NewDraft {
	walletId: number;
	createdBy: number;
	psbt: string;
	recipients: { address: string; amountSats: number }[];
	amountSats: number;
	feeSats: number;
	feeRate: number;
	changeIndex: number | null;
	replacesTxid: string | null;
	expiresAt: string;
	inputs: { txid: string; vout: number; valueSats: number }[];
	signers?: { userId: number; assignedKeyIds: number[] }[];
}

/** Persist a draft + its authoritative input set (+ frozen multisig roster) in
 *  one transaction. The RBF partial-unique index enforces one live replacement. */
export function insertDraft(draft: NewDraft): number {
	return withTransaction((db) => {
		const res = db
			.prepare(
				`INSERT INTO psbt_drafts (wallet_id, created_by, psbt, recipients, amount_sats, fee_sats, fee_rate, change_index, replaces_txid, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				draft.walletId,
				draft.createdBy,
				draft.psbt,
				JSON.stringify(draft.recipients),
				draft.amountSats,
				draft.feeSats,
				draft.feeRate,
				draft.changeIndex,
				draft.replacesTxid,
				draft.expiresAt
			);
		const draftId = Number(res.lastInsertRowid);
		const insInput = db.prepare(
			'INSERT INTO psbt_draft_inputs (draft_id, txid, vout, value_sats) VALUES (?, ?, ?, ?)'
		);
		for (const inp of draft.inputs) insInput.run(draftId, inp.txid, inp.vout, inp.valueSats);
		if (draft.signers && draft.signers.length > 0) {
			const insSigner = db.prepare(
				'INSERT INTO psbt_draft_signers (draft_id, user_id, assigned_key_ids) VALUES (?, ?, ?)'
			);
			for (const s of draft.signers) insSigner.run(draftId, s.userId, JSON.stringify(s.assignedKeyIds));
		}
		return draftId;
	});
}

/** Update a draft's working PSBT + status (used by applySignature / broadcast). */
export function updateDraftPsbt(draftId: number, psbt: string, status: DraftStatus): void {
	getDb()
		.prepare(
			`UPDATE psbt_drafts SET psbt = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
		)
		.run(psbt, status, draftId);
}

/** The AUTHORITATIVE reservation source (§5.4): outpoints locked by an in-flight
 *  draft of this user. An indexed query -- never "parse every stored PSBT". */
export function reservedOutpoints(userId: number): Set<string> {
	const rows = getDb()
		.prepare(
			`SELECT i.txid AS txid, i.vout AS vout
			 FROM psbt_draft_inputs i
			 JOIN psbt_drafts d ON i.draft_id = d.id
			 JOIN wallets w ON d.wallet_id = w.id
			 WHERE w.user_id = ? AND d.status IN ('draft','signing')`
		)
		.all(userId) as unknown as { txid: string; vout: number }[];
	return new Set(rows.map((r) => `${r.txid}:${r.vout}`));
}

/** Which live drafts reserve a given outpoint (for coin-control warnings). */
export function draftsReservingOutpoint(userId: number, txid: string, vout: number): number[] {
	const rows = getDb()
		.prepare(
			`SELECT d.id AS id FROM psbt_draft_inputs i
			 JOIN psbt_drafts d ON i.draft_id = d.id
			 JOIN wallets w ON d.wallet_id = w.id
			 WHERE w.user_id = ? AND i.txid = ? AND i.vout = ? AND d.status IN ('draft','signing')`
		)
		.all(userId, txid, vout) as unknown as { id: number }[];
	return rows.map((r) => r.id);
}

/** Wallet-scoped key ids for the frozen multisig roster snapshot. */
export function walletKeyIds(walletId: number): number[] {
	const rows = getDb()
		.prepare('SELECT id FROM wallet_keys WHERE wallet_id = ? ORDER BY position ASC')
		.all(walletId) as unknown as { id: number }[];
	return rows.map((r) => r.id);
}

/** Owner-scoped status change (abandon). Returns true if a live draft moved.
 *  Frees its reserved inputs since reservedOutpoints only counts draft/signing. */
export function setDraftStatusOwned(
	userId: number,
	walletId: number,
	draftId: number,
	status: DraftStatus,
	fromStatuses: DraftStatus[]
): boolean {
	const placeholders = fromStatuses.map(() => '?').join(',');
	const res = getDb()
		.prepare(
			`UPDATE psbt_drafts SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ? AND wallet_id = ? AND status IN (${placeholders})
			 AND wallet_id IN (SELECT id FROM wallets WHERE user_id = ?)`
		)
		.run(status, draftId, walletId, ...fromStatuses, userId);
	return Number(res.changes) > 0;
}

/** Lazy expiry sweep (§1 expiry): move draft/signing rows past expires_at to
 *  abandoned, freeing their inputs. Called from the sync lane, never a naked
 *  timer that reads SQLite off the SSE path. Returns the count swept. */
export function sweepExpiredDrafts(walletId?: number): number {
	const now = new Date().toISOString();
	const sql = walletId
		? `UPDATE psbt_drafts SET status = 'abandoned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		   WHERE wallet_id = ? AND status IN ('draft','signing') AND expires_at < ?`
		: `UPDATE psbt_drafts SET status = 'abandoned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		   WHERE status IN ('draft','signing') AND expires_at < ?`;
	const res = walletId
		? getDb().prepare(sql).run(walletId, now)
		: getDb().prepare(sql).run(now);
	return Number(res.changes);
}

/** Atomic broadcast claim (§5.4). Exactly one concurrent caller sees changes>0.
 *  A crashed claim self-expires after `staleMs`. */
export function claimBroadcast(walletId: number, draftId: number, staleMs = 60_000): boolean {
	const now = new Date().toISOString();
	const staleBefore = new Date(Date.now() - staleMs).toISOString();
	const res = getDb()
		.prepare(
			`UPDATE psbt_drafts
			 SET broadcast_started_at = ?, updated_at = ?
			 WHERE id = ? AND wallet_id = ? AND txid IS NULL AND status != 'broadcast'
			   AND (broadcast_started_at IS NULL OR broadcast_started_at < ?)`
		)
		.run(now, now, draftId, walletId, staleBefore);
	return Number(res.changes) === 1;
}

/** Release a broadcast claim (an unrecoverable rejection -- stays retryable). */
export function releaseBroadcastClaim(walletId: number, draftId: number): void {
	getDb()
		.prepare('UPDATE psbt_drafts SET broadcast_started_at = NULL WHERE id = ? AND wallet_id = ?')
		.run(draftId, walletId);
}

/** Record a successful broadcast: status, txid, authoritative PSBT. */
export function markBroadcast(walletId: number, draftId: number, txid: string, psbt: string): void {
	getDb()
		.prepare(
			`UPDATE psbt_drafts SET status = 'broadcast', txid = ?, psbt = ?,
			   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ? AND wallet_id = ?`
		)
		.run(txid, psbt, draftId, walletId);
}

/** Mark a draft superseded (duplicate txid or RBF-replaced). */
export function markSuperseded(walletId: number, draftId: number): void {
	getDb()
		.prepare(
			`UPDATE psbt_drafts SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ? AND wallet_id = ?`
		)
		.run(draftId, walletId);
}

/** Any broadcast/confirmed draft of this wallet already carrying `txid`? (dedup) */
export function findBroadcastByTxid(walletId: number, txid: string): number | null {
	const row = getDb()
		.prepare(
			"SELECT id FROM psbt_drafts WHERE wallet_id = ? AND txid = ? AND status IN ('broadcast','confirmed')"
		)
		.get(walletId, txid) as { id: number } | undefined;
	return row ? row.id : null;
}

/** Find the live draft that replaces `replacedTxid` (RBF supersede target). */
export function findDraftByReplacesTxid(walletId: number, replacedTxid: string): number | null {
	const row = getDb()
		.prepare(
			"SELECT id FROM psbt_drafts WHERE wallet_id = ? AND txid = ? AND status IN ('broadcast','confirmed','signing','draft')"
		)
		.get(walletId, replacedTxid) as { id: number } | undefined;
	return row ? row.id : null;
}
