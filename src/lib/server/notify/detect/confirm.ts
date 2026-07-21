/**
 * Confirmation milestones + reorg un-confirmation (WATCHTOWER.md §1.6,
 * §1.6.1). `handleNewBlock` runs on each 'header' event (guarded by the
 * baseline flag, same as watcher.ts, so a reconnect's replayed header can't
 * sweep pending rows mid-warmup):
 *
 *  - The 0->1-conf transition (tx_received, which IS the CONFIRM_THRESHOLD=1
 *    milestone -- ledger.ts's claimReceived already stamps last_milestone=1)
 *    is watcher.ts's job, fired off a 'scripthash' status-change event, NOT
 *    this one. This module only ever (a) notices a mempool/confirmed tx
 *    VANISH (reorg or a never-confirmed drop) and (b) progresses a tx PAST
 *    its already-fired milestone into a deeper opt-in one (3/6-conf).
 *  - Reuses spvGate.ts's spvVerifyConfirmed for every milestone re-fire --
 *    a deeper milestone height still needs a proof.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isOwnSendTx, deriveAddresses, getWalletRowUnscoped, type Wallet } from '$lib/server/wallet/index.js';
import { withTransaction } from '$lib/server/db/index.js';
import { logWarn } from '$lib/server/log.js';
import type { DifficultyFloor } from './difficulty.js';
import { spvVerifyConfirmed, type SpvElectrumRail } from './spvGate.js';
import {
	selectUnconfirmedRows,
	selectReorgWindowRows,
	markMilestone,
	markReplaced,
	markDropped,
	type NotifiedTxidRow
} from './ledger.js';
import { watchDepthFor, type VerboseTx } from './watcher.js';

export const CONFIRM_THRESHOLD = 1;
export const DEFAULT_MILESTONES: readonly number[] = [1];
export const AVAILABLE_MILESTONES: readonly number[] = [1, 3, 6];
export const REORG_RECHECK_DEPTH = 6;

const NOT_FOUND_PATTERN = /not found|no such|unknown transaction|missing transaction|txn-mempool-conflict/i;

export interface HistoryItem {
	tx_hash: string;
	height: number;
}

export interface ConfirmElectrumRail extends SpvElectrumRail {
	/** Verbose tx lookup (Electrum's blockchain.transaction.get(txid, true),
	 *  Core RPC fallback per DECISIONS.md §4.4) -- SAME method watcher.ts's
	 *  rail uses. MUST throw an Error whose message matches NOT_FOUND_PATTERN
	 *  when the tx is genuinely gone (a real reorg/drop), and throw some
	 *  other error for a transient fetch failure. */
	getTx(txid: string): Promise<VerboseTx>;
	getHistory(scripthash: string, lane?: 'interactive' | 'background'): Promise<HistoryItem[]>;
}

export interface MilestoneEvent {
	walletId: number;
	userId: number;
	txid: string;
	milestone: number;
	confirmations: number;
}
export interface ReplacedEvent {
	walletId: number;
	userId: number;
	txid: string;
	/** true = "Confirmed payment reversed" wording; false = "Incoming payment cancelled". */
	wasConfirmed: boolean;
	/** true = no notification fires (own-spend/change/RBF bump); false = tx_replaced fires. */
	silent: boolean;
}

export interface ConfirmHooks {
	/** Per-user milestone routing (T7 wires real prefs); default: [1] only,
	 *  matching cairn (fires just the 1-conf milestone, avoiding fatigue). */
	milestonesForUser?(userId: number): readonly number[];
	/** Inside the SAME transaction as markMilestone -- T3 wires dispatch.ts's
	 *  tx_confirmed write here. Must be synchronous, must never throw. */
	onMilestone?(db: DatabaseSync, event: MilestoneEvent): void;
	afterMilestone?(event: MilestoneEvent): void;
	onReplaced?(db: DatabaseSync, event: ReplacedEvent): void;
	afterReplaced?(event: ReplacedEvent): void;
}

function nextMilestone(lastMilestone: number, milestones: readonly number[]): number | null {
	const sorted = [...milestones].sort((a, b) => a - b);
	for (const m of sorted) if (m > lastMilestone) return m;
	return null;
}

/**
 * Re-fetch EVERY watched scripthash's history for the wallet and check
 * whether `txid` appears anywhere (WATCHTOWER.md §1.6.1 step 1). Fails
 * closed: `anyFetched=false` (Electrum unreachable on every scripthash)
 * means "don't know", never "gone".
 */
async function walletStillContainsTxid(
	rail: ConfirmElectrumRail,
	wallet: Wallet,
	txid: string
): Promise<{ anyFetched: boolean; found: boolean }> {
	let anyFetched = false;
	let found = false;
	for (const chain of [0, 1] as const) {
		const depth = watchDepthFor(wallet.id, chain);
		const addrs = deriveAddresses(wallet, chain, 0, depth);
		for (const a of addrs) {
			try {
				const history = await rail.getHistory(a.scripthash, 'background');
				anyFetched = true;
				if (history.some((h) => h.tx_hash === txid)) found = true;
			} catch {
				// this scripthash's fetch failed -- keep trying the others
			}
		}
	}
	return { anyFetched, found };
}

/**
 * Routed when `getTx` throws not-found (WATCHTOWER.md §1.6.1).
 * `wasConfirmed` is whatever the ledger row said BEFORE this call (a
 * 'pending' row that vanishes was never confirmed; a 'notified' row that
 * vanishes was, and IS the reorg case).
 */
async function reconcileDisappeared(
	rail: ConfirmElectrumRail,
	row: NotifiedTxidRow,
	hooks: ConfirmHooks
): Promise<void> {
	const wallet = getWalletRowUnscoped(row.walletId);
	if (!wallet) return; // wallet vanished mid-check -- nothing to reconcile
	const { anyFetched, found } = await walletStillContainsTxid(rail, wallet, row.txid);
	if (!anyFetched) return; // Electrum unreachable on every rail -- fail closed, retry later
	if (found) return; // a no-txindex miss on getTx alone -- still present in address history

	const wasConfirmed = row.confirmed === true;
	let ownSend = false;
	try {
		ownSend = isOwnSendTx(row.walletId, row.txid);
	} catch {
		ownSend = false; // fails OPEN -- a lookup error must never suppress a real cancellation alert
	}
	const silent = (row.amountSats ?? 0) <= 0 || ownSend;

	if (silent) {
		markDropped(row.walletId, row.userId, row.txid);
		return;
	}

	const won = withTransaction((db) => {
		if (!markReplaced(row.walletId, row.userId, row.txid)) return false;
		const event: ReplacedEvent = {
			walletId: row.walletId,
			userId: row.userId,
			txid: row.txid,
			wasConfirmed,
			silent: false
		};
		try {
			hooks.onReplaced?.(db, event);
		} catch (e) {
			logWarn('watchtower', { event: 'on_replaced_hook_threw', txid: row.txid, err: String(e) });
		}
		return true;
	});
	if (won) {
		try {
			hooks.afterReplaced?.({ walletId: row.walletId, userId: row.userId, txid: row.txid, wasConfirmed, silent: false });
		} catch (e) {
			logWarn('watchtower', { event: 'after_replaced_hook_threw', txid: row.txid, err: String(e) });
		}
	}
}

async function processUnconfirmedRow(
	rail: ConfirmElectrumRail,
	row: NotifiedTxidRow,
	hooks: ConfirmHooks
): Promise<void> {
	try {
		await rail.getTx(row.txid);
		// Still fetchable -- nothing to do here; the 0->1-conf transition (and
		// its tx_received) fires off a scripthash event, not this one.
	} catch (e) {
		if (NOT_FOUND_PATTERN.test(String(e))) {
			await reconcileDisappeared(rail, row, hooks);
		}
		// else: a transient fetch error -- defer, retry on the next block.
	}
}

async function processReorgWindowRow(
	rail: ConfirmElectrumRail,
	floor: DifficultyFloor,
	tipHeight: number,
	row: NotifiedTxidRow,
	hooks: ConfirmHooks
): Promise<void> {
	let detail: VerboseTx;
	try {
		detail = await rail.getTx(row.txid);
	} catch (e) {
		if (NOT_FOUND_PATTERN.test(String(e))) {
			await reconcileDisappeared(rail, row, hooks);
		}
		return;
	}

	const milestones = hooks.milestonesForUser?.(row.userId) ?? DEFAULT_MILESTONES;
	const milestone = nextMilestone(row.lastMilestone, milestones);
	if (milestone === null) return; // no further milestone configured/available
	const confirmations = detail.confirmations ?? 0; // absent -- fail closed, not confirmed enough
	if (confirmations < milestone) return; // not there yet

	if (row.confirmedHeight === null) return; // baselined/legacy -- never re-checked
	// A deeper milestone height still needs a proof (WATCHTOWER.md §1.6).
	const verified = await spvVerifyConfirmed(rail, floor, row.txid, row.confirmedHeight);
	if (!verified) return; // defer -- retries on the next block

	const won = withTransaction((db) => {
		if (!markMilestone(row.walletId, row.userId, row.txid, milestone, row.confirmedHeight!)) return false;
		const event: MilestoneEvent = {
			walletId: row.walletId,
			userId: row.userId,
			txid: row.txid,
			milestone,
			confirmations
		};
		try {
			hooks.onMilestone?.(db, event);
		} catch (e) {
			logWarn('watchtower', { event: 'on_milestone_hook_threw', txid: row.txid, err: String(e) });
		}
		return true;
	});
	if (won) {
		try {
			hooks.afterMilestone?.({
				walletId: row.walletId,
				userId: row.userId,
				txid: row.txid,
				milestone,
				confirmations
			});
		} catch (e) {
			logWarn('watchtower', { event: 'after_milestone_hook_threw', txid: row.txid, err: String(e) });
		}
	}
}

/**
 * Runs on each 'header' event. Never throws -- every row is processed
 * best-effort; one row's failure must never block the rest.
 */
export async function handleNewBlock(
	rail: ConfirmElectrumRail,
	floor: DifficultyFloor,
	baselineComplete: boolean,
	hooks: ConfirmHooks = {}
): Promise<void> {
	if (!baselineComplete) return;
	try {
		const tipHeight = floor.tipHeight();
		const unconfirmed = selectUnconfirmedRows();
		for (const row of unconfirmed) {
			try {
				await processUnconfirmedRow(rail, row, hooks);
			} catch (e) {
				logWarn('watchtower', { event: 'process_unconfirmed_row_threw', txid: row.txid, err: String(e) });
			}
		}
		const reorgWindow = selectReorgWindowRows(tipHeight, REORG_RECHECK_DEPTH);
		for (const row of reorgWindow) {
			try {
				await processReorgWindowRow(rail, floor, tipHeight, row, hooks);
			} catch (e) {
				logWarn('watchtower', { event: 'process_reorg_window_row_threw', txid: row.txid, err: String(e) });
			}
		}
	} catch (e) {
		logWarn('watchtower', { event: 'handle_new_block_threw', err: String(e) });
	}
}
