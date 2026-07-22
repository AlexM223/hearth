/**
 * SWR sync (WALLET-ENGINE §2.4, §4.3). syncWallet runs the gap-limit scan on
 * the Electrum background lane and rewrites the wallet_snapshots row; the SWR
 * reads (getBalance/getHistory/getUtxos) return the persisted snapshot
 * SYNCHRONOUSLY (no Electrum in a page load) and kick a background refresh when
 * stale/dirty. Single-flight per wallet so concurrent loads coalesce.
 */
import type { SpendableUtxo, TxHistoryEntry, Wallet } from './types.js';
import { scanWallet, type ScanRail, type ScanResult } from './scan.js';
import {
	getUtxoRows,
	getTransactionRows,
	getWalletRowUnscoped,
	persistScan,
	readSnapshotRow,
	markSnapshotDirty,
	sweepExpiredDrafts
} from './repo.js';

/** Node surface sync needs: the Electrum scan rail + best-known tip height. */
export interface SyncNode {
	electrum: ScanRail;
	tipHeight?: number | null;
}

export interface WalletSnapshot {
	confirmedSats: number;
	unconfirmedSats: number;
	addressCount: number;
	usedCount: number;
	txCount: number;
	receivePeek: string | null;
	truncated: boolean;
}

const STALE_MS = 60_000; // SWR: a snapshot older than this triggers a background refresh
const inflight = new Map<number, Promise<void>>();

/** Full scan + snapshot rewrite. Idempotent; single-flight per wallet. */
export function syncWallet(
	node: SyncNode,
	walletId: number,
	opts?: { forceRefresh?: boolean }
): Promise<void> {
	const existing = inflight.get(walletId);
	if (existing && !opts?.forceRefresh) return existing;

	const run = (async () => {
		const wallet = getWalletRowUnscoped(walletId);
		if (!wallet) return;
		// Lazy expiry sweep on the sync lane (never a naked SSE-path timer, §1).
		sweepExpiredDrafts(walletId);
		const result = await scanWallet(wallet, node.electrum);
		persistResult(wallet, result);
	})().finally(() => {
		if (inflight.get(walletId) === run) inflight.delete(walletId);
	});

	inflight.set(walletId, run);
	return run;
}

function persistResult(wallet: Wallet, result: ScanResult): void {
	const snapshot: WalletSnapshot = {
		confirmedSats: result.confirmedSats,
		unconfirmedSats: result.unconfirmedSats,
		addressCount: result.addresses.length,
		usedCount: result.addresses.filter((a) => a.used).length,
		txCount: result.transactions.length,
		receivePeek:
			result.addresses.find((a) => a.chain === 0 && !a.used)?.address ??
			result.addresses.find((a) => a.chain === 0)?.address ??
			null,
		truncated: result.truncated
	};
	const summary = {
		name: wallet.name,
		kind: wallet.kind,
		confirmedSats: result.confirmedSats,
		unconfirmedSats: result.unconfirmedSats
	};
	persistScan(wallet.id, {
		addresses: result.addresses.map((a) => ({
			chain: a.chain,
			index: a.index,
			address: a.address,
			scripthash: a.scripthash,
			scriptPubKey: a.scriptPubKey,
			used: a.used,
			firstSeenHeight: a.firstSeenHeight
		})),
		utxos: result.utxos.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			valueSats: u.valueSats,
			chain: u.chain,
			index: u.index,
			address: u.address,
			height: u.height,
			coinbase: u.coinbase,
			unconfirmedTrust: u.unconfirmedTrust
		})),
		transactions: result.transactions,
		snapshotJson: JSON.stringify(snapshot),
		summaryJson: JSON.stringify(summary),
		receiveCursor: result.receiveCursor,
		changeCursor: result.changeCursor,
		lastSyncedAtMs: Date.now()
	});
}

/** Mark a wallet's snapshot dirty (a subscribed scripthash changed) so the next
 *  SWR read schedules a rescan. Never called from the SSE publish path. */
export function markWalletDirty(walletId: number): void {
	markSnapshotDirty(walletId, Date.now());
}

// ------------------------------------------------------------- SWR read side

/** True when the persisted snapshot is stale or dirty (a refresh is warranted). */
function needsRefresh(walletId: number): boolean {
	const snap = readSnapshotRow(walletId);
	if (!snap) return true;
	if (snap.dirtySince != null) return true;
	return Date.now() - snap.lastSyncedAt > STALE_MS;
}

/** Kick a background refresh if warranted; never awaited by a page load. */
function maybeRefresh(node: SyncNode | undefined, walletId: number): void {
	if (!node) return;
	if (needsRefresh(walletId)) {
		syncWallet(node, walletId).catch(() => {
			// A background sync failure must never surface to the page; SWR keeps
			// serving the last good snapshot and retries on the next read.
		});
	}
}

export function getBalance(
	walletId: number,
	node?: SyncNode
): { confirmedSats: number; unconfirmedSats: number } {
	const snap = readSnapshotRow(walletId);
	maybeRefresh(node, walletId);
	const s = snap?.snapshot as WalletSnapshot | undefined;
	return { confirmedSats: s?.confirmedSats ?? 0, unconfirmedSats: s?.unconfirmedSats ?? 0 };
}

export function getSnapshot(walletId: number, node?: SyncNode): WalletSnapshot | null {
	const snap = readSnapshotRow(walletId);
	maybeRefresh(node, walletId);
	return (snap?.snapshot as WalletSnapshot | undefined) ?? null;
}

export function getHistory(walletId: number, limit = 50, node?: SyncNode): TxHistoryEntry[] {
	maybeRefresh(node, walletId);
	return getTransactionRows(walletId, limit).map((r) => ({
		txid: r.txid,
		height: r.height,
		blockTime: r.block_time,
		deltaSats: r.delta_sats,
		feeSats: r.fee_sats
	}));
}

export function getUtxos(walletId: number, node?: SyncNode): SpendableUtxo[] {
	maybeRefresh(node, walletId);
	return getUtxoRows(walletId).map((r) => ({
		txid: r.txid,
		vout: r.vout,
		valueSats: r.value_sats,
		height: r.height,
		address: r.address,
		chain: r.chain,
		index: r.address_index,
		coinbase: r.coinbase === 1,
		unconfirmedTrust: (r.unconfirmed_trust as 'own-change' | 'received' | null) ?? undefined
	}));
}
