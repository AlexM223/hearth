/**
 * Wires the detection layer's hook interfaces (detect/watcher.ts's
 * WatchtowerHooks, detect/confirm.ts's ConfirmHooks) to the real dispatch()
 * pipeline -- this is what turns a verified detection into an actual
 * notification. `onReceived`/`onMilestone`/`onReplaced` run INSIDE the
 * caller's already-open ledger-claim transaction (cairn-fzqpe) and MUST use
 * dispatchInTransaction, never dispatch() (which would try to open a second,
 * nested transaction). `afterReceived`/`afterMilestone`/`afterReplaced` run
 * strictly after commit and publish the SSE nudge + markWalletDirty.
 *
 * Message bodies here are minimal-but-correct placeholders honoring
 * DECISIONS.md §3's sats-first human-rationale rule (WATCHTOWER.md §3.1's
 * exact examples) -- T5 (render.ts) is the formal per-channel renderer;
 * this wiring only ever builds the in-app NotificationPayload.
 */
import { getWalletRowUnscoped, markWalletDirty } from '../wallet/index.js';
import { dispatchInTransaction, publishDispatched, type DispatchOptions } from './dispatch.js';
import type { NotificationPayload } from './types.js';
import type { WatchtowerHooks, ReceivedEvent } from './detect/watcher.js';
import type { ConfirmHooks, MilestoneEvent, ReplacedEvent } from './detect/confirm.js';

function walletName(walletId: number): string {
	return getWalletRowUnscoped(walletId)?.name ?? 'your wallet';
}

/** Sats-first amount string, e.g. 150000 -> "0.0015". Trims trailing zeros
 *  but always keeps at least one fractional digit. */
export function formatBtc(amountSats: number): string {
	const btc = amountSats / 1e8;
	const fixed = btc.toFixed(8);
	const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '.0');
	return trimmed;
}

function receivedPayload(event: ReceivedEvent): NotificationPayload {
	const name = walletName(event.wallet.walletId);
	if (event.amountSats > 0) {
		return {
			type: 'tx_received',
			userId: event.wallet.userId,
			level: 'success',
			title: 'Payment received',
			body: `You received ${formatBtc(event.amountSats)} BTC in ${name}.`,
			detail: { amountSats: event.amountSats, walletId: event.wallet.walletId, txid: event.txid, height: event.height },
			link: `/wallets/${event.wallet.walletId}`
		};
	}
	// A spend with no change back to us, or an unfetchable detail -- never a
	// bogus "+amount" (WATCHTOWER.md §1.4).
	return {
		type: 'tx_received',
		userId: event.wallet.userId,
		level: 'info',
		title: 'New wallet activity',
		body: `Your wallet ${name} has new activity.`,
		detail: { walletId: event.wallet.walletId, txid: event.txid, height: event.height },
		link: `/wallets/${event.wallet.walletId}`
	};
}

function milestonePayload(event: MilestoneEvent): NotificationPayload {
	const name = walletName(event.walletId);
	return {
		type: 'tx_confirmed',
		userId: event.userId,
		level: 'info',
		title: 'Payment confirmed',
		body: `Your payment in ${name} now has ${event.confirmations} confirmation${event.confirmations === 1 ? '' : 's'}.`,
		detail: { walletId: event.walletId, txid: event.txid, milestone: event.milestone, confirmations: event.confirmations },
		link: `/wallets/${event.walletId}`
	};
}

/** WATCHTOWER.md §1.6.1: the reversal/cancellation payload carries NO `txid`
 *  (it would 404) and NO `amountSats` key (a bare +amount would misread as
 *  a receipt). */
function replacedPayload(event: ReplacedEvent): NotificationPayload {
	const name = walletName(event.walletId);
	if (event.wasConfirmed) {
		return {
			type: 'tx_replaced',
			userId: event.userId,
			level: 'error',
			title: 'Confirmed payment reversed',
			body: `A confirmed payment in ${name} was removed from the chain in a reorganization.`,
			detail: { walletId: event.walletId },
			link: `/wallets/${event.walletId}`
		};
	}
	return {
		type: 'tx_replaced',
		userId: event.userId,
		level: 'warn',
		title: 'Incoming payment cancelled',
		body: `An incoming payment to ${name} was cancelled before it confirmed.`,
		detail: { walletId: event.walletId },
		link: `/wallets/${event.walletId}`
	};
}

export function createWatchtowerHooks(opts: DispatchOptions = {}): WatchtowerHooks {
	return {
		onReceived(db, event) {
			dispatchInTransaction(db, receivedPayload(event), opts);
		},
		afterReceived(event) {
			publishDispatched(receivedPayload(event));
			markWalletDirty(event.wallet.walletId);
		}
	};
}

export function createConfirmHooks(opts: DispatchOptions = {}): ConfirmHooks {
	return {
		onMilestone(db, event) {
			dispatchInTransaction(db, milestonePayload(event), opts);
		},
		afterMilestone(event) {
			publishDispatched(milestonePayload(event));
			markWalletDirty(event.walletId);
		},
		onReplaced(db, event) {
			dispatchInTransaction(db, replacedPayload(event), opts);
		},
		afterReplaced(event) {
			publishDispatched(replacedPayload(event));
			markWalletDirty(event.walletId);
		}
	};
}
