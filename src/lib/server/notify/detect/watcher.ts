/**
 * The watchtower detection service (WATCHTOWER.md §1). `handleScripthashChange`
 * is the fail-closed heart: a scripthash status-change -> delta vs the
 * `notified_txids` ledger -> the SPV gate -> an atomic claim. Every handler
 * is wrapped and NEVER throws (DECISIONS.md §4.9 invariant 4, applied to
 * notify) -- a detection bug must never crash the app.
 *
 * Reuses the wallet module's public surface for wallet enumeration AND
 * scriptPubKey sets -- WATCHTOWER.md §0.3: "the notify watcher reuses the
 * wallet module's public surface to... derive watched scripts/scriptPubKeys
 * (deriveAddresses...) rather than re-deriving." The scriptPubKey set is
 * therefore computed via a FRESH deriveAddresses call at the same depth
 * refreshWatches uses, never by reading the (possibly still-empty, if the
 * wallet has never been synced/scanned) persisted `addresses` table --
 * caught live by the regtest e2e test (§6.8): a watch-only wallet that had
 * never been synced underreported every genuine receive as 0 sats.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { NodeClient } from '$lib/server/node/index.js';
import {
	deriveAddresses,
	listAllWalletRows,
	getWalletRowUnscoped,
	highestUsedIndex,
	GAP_LIMIT,
	type Wallet
} from '$lib/server/wallet/index.js';
import { withTransaction } from '$lib/server/db/index.js';
import { logWarn } from '$lib/server/log.js';
import { createDifficultyFloor, type DifficultyFloor } from './difficulty.js';
import { spvVerifyConfirmed, type SpvElectrumRail } from './spvGate.js';
import { alreadyNotified, trackPendingInbound, claimReceived, baselineTxids } from './ledger.js';

export const WATCH_WINDOW = 30;
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Ownership-token discipline (cairn-1hb0): this OBJECT REFERENCE is compared
 *  by identity (`===`), not by field equality, so a wallet delete+recreate
 *  that reuses an xpub -- or an xpub shared by two wallets -- can never let a
 *  stale in-flight handler misattribute a deposit to the wrong owner. */
export interface Watched {
	walletId: number;
	userId: number;
	chain: 0 | 1;
	index: number;
	address: string;
}

export interface HistoryItem {
	tx_hash: string;
	height: number;
}

export interface VerboseVout {
	value?: number;
	n?: number;
	scriptPubKey?: { hex?: string };
}
export interface VerboseTx {
	vout?: VerboseVout[];
	/** Present once the tx is confirmed (Electrum verbose / Core RPC shape).
	 *  Used by detect/confirm.ts's milestone progression -- undefined/absent
	 *  is treated as "not confirmed enough yet" (fail closed), never a guess. */
	confirmations?: number;
}

/** The narrow Electrum surface the watcher needs beyond the SPV gate's. */
export interface WatcherElectrumRail extends SpvElectrumRail {
	getHistory(scripthash: string, lane?: 'interactive' | 'background'): Promise<HistoryItem[]>;
	subscribeScripthash(scripthash: string): Promise<string | null>;
	unsubscribeScripthash(scripthash: string): Promise<boolean>;
	/** Verbose tx detail (Electrum's blockchain.transaction.get(txid, true), Core
	 *  RPC fallback per DECISIONS.md §4.4) -- used ONLY for the direction/value
	 *  computation (§1.4), never for the SPV proof itself. */
	getTx(txid: string): Promise<VerboseTx>;
}

export interface ReceivedEvent {
	wallet: Watched;
	txid: string;
	amountSats: number;
	height: number;
}

/**
 * Runs INSIDE the SAME transaction as the ledger claim (WATCHTOWER.md §1.5,
 * cairn-fzqpe: a crash between the claim and the record must never leave a
 * txid permanently 'notified' with nothing ever recorded). T3's dispatch.ts
 * wires the real in-app events write here. MUST be synchronous (node:sqlite
 * transaction discipline) and must never throw.
 */
export type ReceivedRecorder = (db: DatabaseSync, event: ReceivedEvent) => void;
/** Best-effort, AFTER commit (SSE publish, markWalletDirty -- T3). Never
 *  allowed to affect whether the claim/record succeeded. */
export type ReceivedSideEffect = (event: ReceivedEvent) => void;

export interface WatchtowerHooks {
	onReceived?: ReceivedRecorder;
	afterReceived?: ReceivedSideEffect;
}

export interface WatcherState {
	byScripthash: Map<string, Watched>;
	inFlight: Set<string>;
	baselinedScripthashes: Set<string>;
	/** False during startup warmup (WATCHTOWER.md §1.1 step 1) -- a reconnect's
	 *  replayed events must never sweep back-history mid-warmup. Tests that
	 *  exercise handleScripthashChange directly set this true first. */
	baselineComplete: boolean;
	floor: DifficultyFloor;
}

export function createWatcherState(): WatcherState {
	return {
		byScripthash: new Map(),
		inFlight: new Set(),
		baselinedScripthashes: new Set(),
		baselineComplete: false,
		floor: createDifficultyFloor()
	};
}

/** True iff the wallet row this Watched token was minted for still exists
 *  (a FK-cascade offboard/delete may have removed it since). Sync DB read. */
function walletStillExists(w: Watched): boolean {
	return getWalletRowUnscoped(w.walletId) !== null;
}

/** scriptPubKey set (lowercase hex) for EVERY watched address of the wallet,
 *  computed via a FRESH deriveAddresses call (the wallet module's public
 *  surface) at the SAME depth refreshWatches subscribes -- correct even for
 *  a wallet that has never been synced/scanned (the persisted `addresses`
 *  table may still be empty then; this never depends on it). */
function walletScriptSet(walletId: number): Set<string> {
	const wallet = getWalletRowUnscoped(walletId);
	if (!wallet) return new Set();
	const scripts = new Set<string>();
	for (const chain of [0, 1] as const) {
		const depth = watchDepthFor(walletId, chain);
		for (const addr of deriveAddresses(wallet, chain, 0, depth)) {
			scripts.add(addr.scriptPubKey.toLowerCase());
		}
	}
	return scripts;
}

const btcToSats = (btc: number): number => Math.round(btc * 1e8);

/** receivedSats (WATCHTOWER.md §1.4): sum of vout values whose scriptPubKey
 *  is one of THIS wallet's own -- an ordinary spend with no change back to us
 *  (or an unfetchable detail) correctly resolves to 0, never a guess. */
function computeReceivedSats(tx: VerboseTx, scriptSet: Set<string>): number {
	let sats = 0;
	for (const v of tx.vout ?? []) {
		const spk = v.scriptPubKey?.hex?.toLowerCase();
		if (spk && scriptSet.has(spk) && typeof v.value === 'number') sats += btcToSats(v.value);
	}
	return sats;
}

/** The per-scripthash baseline gate (WATCHTOWER.md §1.1 step 4, cairn-u7bw/
 *  -3bt1): silently record a never-before-seen scripthash's ENTIRE current
 *  history so a first subscription (or a post-reconnect re-baseline) can
 *  never flood pre-existing activity as fresh "payment received" events.
 *  Returns WITHOUT notifying -- accepting one possible missed live
 *  notification on a genuinely brand-new address is the correct trade. */
async function baselineScripthash(
	rail: WatcherElectrumRail,
	state: WatcherState,
	sh: string,
	w: Watched
): Promise<void> {
	let history: HistoryItem[];
	try {
		history = await rail.getHistory(sh, 'background');
	} catch (e) {
		logWarn('watchtower', { event: 'baseline_history_fetch_failed', scripthash: sh, err: String(e) });
		return; // retry on the next status-change event
	}
	if (state.byScripthash.get(sh) !== w) return; // TOCTOU: ownership changed mid-await
	const confirmedTxids = history.filter((h) => h.height > 0).map((h) => h.tx_hash);
	baselineTxids(w.walletId, w.userId, confirmedTxids);
	state.baselinedScripthashes.add(sh);
}

/**
 * The fail-closed heart (WATCHTOWER.md §1.1-§1.5). Never throws -- every
 * failure mode (Electrum down, unverifiable proof, a vanished wallet
 * mid-await) returns quietly and relies on the NEXT status-change event to
 * retry; nothing is ever written to the ledger on a deferred outcome.
 */
export async function handleScripthashChange(
	state: WatcherState,
	rail: WatcherElectrumRail,
	sh: string,
	hooks: WatchtowerHooks = {}
): Promise<void> {
	try {
		if (!state.baselineComplete) return; // ignore during startup warmup

		const w = state.byScripthash.get(sh);
		if (!w) return;

		if (!walletStillExists(w)) {
			state.byScripthash.delete(sh);
			state.baselinedScripthashes.delete(sh);
			void rail.unsubscribeScripthash(sh).catch(() => {});
			return;
		}

		if (state.inFlight.has(sh)) return; // concurrency dedup
		state.inFlight.add(sh);
		try {
			if (!state.baselinedScripthashes.has(sh)) {
				await baselineScripthash(rail, state, sh, w);
				return;
			}

			let history: HistoryItem[];
			try {
				history = await rail.getHistory(sh, 'background');
			} catch (e) {
				logWarn('watchtower', { event: 'history_fetch_failed', scripthash: sh, err: String(e) });
				return;
			}
			// TOCTOU (cairn-mo36): the wallet may have been deleted or the
			// scripthash re-owned while this await was in flight.
			if (state.byScripthash.get(sh) !== w) return;

			for (const item of history) {
				if (item.height <= 0) {
					// A mempool tx is never surfaced as "received" -- only tracked so
					// it can (a) fire once confirmed and (b) be noticed if it
					// disappears (double-spend/RBF) before confirming.
					await trackPendingValue(rail, w, item.tx_hash);
					continue;
				}
				if (alreadyNotified(w.walletId, w.userId, item.tx_hash)) continue;

				// The SPV gate -- proceed to value computation and firing ONLY on
				// {ok:true}. Every other outcome is a silent defer (nothing written).
				const verified = await spvVerifyConfirmed(rail, state.floor, item.tx_hash, item.height);
				if (!verified) continue;

				if (state.byScripthash.get(sh) !== w) return; // TOCTOU re-check post-await

				let tx: VerboseTx;
				try {
					tx = await rail.getTx(item.tx_hash);
				} catch {
					tx = { vout: [] };
				}
				const scriptSet = walletScriptSet(w.walletId);
				const receivedSats = computeReceivedSats(tx, scriptSet);

				fireReceived(w, item.tx_hash, receivedSats, item.height, hooks);
			}
		} finally {
			state.inFlight.delete(sh);
		}
	} catch (e) {
		// Belt-and-suspenders: handleScripthashChange must NEVER throw
		// (DECISIONS.md §4.9 invariant 4). Every awaited call above already has
		// its own catch, so reaching here means a programming bug -- log and
		// swallow rather than crash the process.
		logWarn('watchtower', { event: 'handle_scripthash_change_threw', scripthash: sh, err: String(e) });
		state.inFlight.delete(sh);
	}
}

async function trackPendingValue(rail: WatcherElectrumRail, w: Watched, txid: string): Promise<void> {
	if (alreadyNotified(w.walletId, w.userId, txid)) return; // 'pending' itself isn't "already", but a notified/replaced/dropped row is terminal
	let tx: VerboseTx;
	try {
		tx = await rail.getTx(txid);
	} catch {
		tx = { vout: [] };
	}
	const scriptSet = walletScriptSet(w.walletId);
	const receivedSats = computeReceivedSats(tx, scriptSet);
	trackPendingInbound(w.walletId, w.userId, txid, receivedSats);
}

/** Atomic claim + record (WATCHTOWER.md §1.5) -- one withTransaction so a
 *  crash between the ledger claim and the in-app record can never silently
 *  lose a payment notification (cairn-fzqpe). Losers of the claim race
 *  suppress silently (exactly one winner fires). */
function fireReceived(
	w: Watched,
	txid: string,
	amountSats: number,
	height: number,
	hooks: WatchtowerHooks
): void {
	const event: ReceivedEvent = { wallet: w, txid, amountSats, height };
	const won = withTransaction((db) => {
		if (!claimReceived(db, w.walletId, w.userId, txid, amountSats, height)) return false;
		try {
			hooks.onReceived?.(db, event);
		} catch (e) {
			logWarn('watchtower', { event: 'on_received_hook_threw', txid, err: String(e) });
		}
		return true;
	});
	if (!won) return;
	try {
		hooks.afterReceived?.(event);
	} catch (e) {
		logWarn('watchtower', { event: 'after_received_hook_threw', txid, err: String(e) });
	}
}

// -------------------------------------------------------------- enumeration

/** highestUsedIndex + GAP_LIMIT + 1, floored at WATCH_WINDOW (cairn-wcxw: a
 *  fixed index-0 window silently missed live addresses past index 30). */
export function watchDepthFor(walletId: number, chain: 0 | 1): number {
	return Math.max(WATCH_WINDOW, highestUsedIndex(walletId, chain) + GAP_LIMIT + 1);
}

/** Rebuild `byScripthash` for one wallet across both chains. Subscribing is
 *  the caller's job (needs the live rail); this only (re)computes the
 *  in-memory ownership map, resetting any stale per-scripthash state when a
 *  scripthash's owner changes (a new Watched object reference is minted every
 *  call, so old in-flight/baseline markers referencing the previous owner
 *  are naturally invalidated by the identity check in handleScripthashChange).
 */
export function refreshWatches(state: WatcherState, wallet: Wallet): Map<string, Watched> {
	const out = new Map<string, Watched>();
	for (const chain of [0, 1] as const) {
		const depth = watchDepthFor(wallet.id, chain);
		for (const addr of deriveAddresses(wallet, chain, 0, depth)) {
			const w: Watched = { walletId: wallet.id, userId: wallet.userId, chain, index: addr.index, address: addr.address };
			out.set(addr.scripthash, w);
			state.byScripthash.set(addr.scripthash, w);
		}
	}
	return out;
}

/** One enumeration pass across EVERY user's wallets (WATCHTOWER.md §1.0) --
 *  ensures coverage independent of whether a wallet page has ever been
 *  visited. Idempotent subscriptions; never throws (best-effort per wallet). */
export async function enumerateAndSubscribe(state: WatcherState, rail: WatcherElectrumRail): Promise<void> {
	const wallets = listAllWalletRows();
	for (const wallet of wallets) {
		try {
			const scripthashes = refreshWatches(state, wallet);
			for (const sh of scripthashes.keys()) {
				try {
					await rail.subscribeScripthash(sh);
				} catch (e) {
					logWarn('watchtower', { event: 'subscribe_failed', scripthash: sh, err: String(e) });
				}
			}
		} catch (e) {
			logWarn('watchtower', { event: 'enumerate_wallet_failed', walletId: wallet.id, err: String(e) });
		}
	}
}

// ------------------------------------------------------------------ service

/** Adapts a live NodeClient's Electrum pool to the narrow WatcherElectrumRail
 *  surface, always on the BACKGROUND lane (DECISIONS.md §4.4: a detection
 *  sweep must never starve an interactive send-page load). */
/** Exported so hooks.server.ts (T8) can reuse the SAME adapter for
 *  detect/confirm.ts's handleNewBlock -- ConfirmElectrumRail's shape
 *  (getHistory/getMerkleProof/getBlockHeader/getTx) is a strict subset of
 *  WatcherElectrumRail's, so one adapter instance satisfies both. */
export function railFromNode(node: NodeClient): WatcherElectrumRail {
	return {
		getHistory: (sh) => node.electrum.getHistory(sh, 'background'),
		getMerkleProof: (txid, height) => node.electrum.getMerkleProof(txid, height, 'background'),
		getBlockHeader: (height) => node.electrum.getBlockHeader(height, 'background'),
		subscribeScripthash: (sh) => node.electrum.subscribeScripthash(sh),
		unsubscribeScripthash: (sh) => node.electrum.unsubscribeScripthash(sh),
		getTx: async (txid) => (await node.electrum.getTransaction(txid, true, 'background')) as VerboseTx
	};
}

const STARTUP_DELAY_MS = 10_000;

export interface Watchtower {
	state: WatcherState;
	stop(): void;
}

/**
 * Starts the watchtower service (WATCHTOWER.md §1.0): attaches to the
 * SHARED Electrum pool's 'scripthash' events (no second subscription
 * socket), waits STARTUP_DELAY_MS for the DB/rails to settle, then runs the
 * first enumeration pass (flipping `baselineComplete` true) and repeats it
 * every REFRESH_INTERVAL_MS. Best-effort and never throws.
 */
export function startWatchtower(node: NodeClient, hooks: WatchtowerHooks = {}): Watchtower {
	const state = createWatcherState();
	const rail = railFromNode(node);
	let stopped = false;
	let refreshTimer: NodeJS.Timeout | null = null;

	const onScripthash = (sh: string): void => {
		if (stopped) return;
		void handleScripthashChange(state, rail, sh, hooks);
	};
	node.electrum.on('scripthash', onScripthash);

	const startupTimer = setTimeout(() => {
		if (stopped) return;
		enumerateAndSubscribe(state, rail)
			.then(() => {
				state.baselineComplete = true;
			})
			.catch((e: unknown) => {
				logWarn('watchtower', { event: 'initial_enumeration_failed', err: String(e) });
				state.baselineComplete = true; // fail open on ENUMERATION only -- a failed initial pass must not wedge the service forever silent; per-scripthash baseline gate still protects against back-history floods for whatever DID get subscribed.
			});
		refreshTimer = setInterval(() => {
			enumerateAndSubscribe(state, rail).catch((e: unknown) => {
				logWarn('watchtower', { event: 'refresh_enumeration_failed', err: String(e) });
			});
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	}, STARTUP_DELAY_MS);
	startupTimer.unref?.();

	return {
		state,
		stop() {
			stopped = true;
			clearTimeout(startupTimer);
			if (refreshTimer) clearInterval(refreshTimer);
			node.electrum.off('scripthash', onScripthash);
		}
	};
}
