/**
 * UTXO reservation (WALLET-ENGINE §5.4). A coin is reserved by being an input of
 * an in-flight draft (status draft|signing). The authoritative source is an
 * INDEXED query over psbt_draft_inputs (never Heartwood's parse-every-PSBT).
 * Automatic selection excludes reserved coins; coin-control may re-target one but
 * surfaces a non-blocking warning naming the reserving draft(s).
 */
import {
	reservedOutpoints as repoReservedOutpoints,
	draftsReservingOutpoint,
	setDraftStatusOwned,
	sweepExpiredDrafts,
	getWalletRow
} from './repo.js';
import { ForbiddenError, NotFoundError } from './errors.js';

export function reservedOutpoints(userId: number): Set<string> {
	return repoReservedOutpoints(userId);
}

export interface ReservationWarning {
	txid: string;
	vout: number;
	draftIds: number[];
}

/** Non-blocking warnings for coin-control that re-targets reserved coins. */
export function reservationWarnings(
	userId: number,
	onlyUtxos: { txid: string; vout: number }[]
): ReservationWarning[] {
	const warnings: ReservationWarning[] = [];
	for (const o of onlyUtxos) {
		const draftIds = draftsReservingOutpoint(userId, o.txid, o.vout);
		if (draftIds.length > 0) warnings.push({ txid: o.txid, vout: o.vout, draftIds });
	}
	return warnings;
}

/** Abandon a draft (owner-only), freeing its reserved inputs. */
export function abandonDraft(userId: number, walletId: number, draftId: number): boolean {
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new NotFoundError('wallet not found');
	if (wallet.userId !== userId) throw new ForbiddenError('only the owner can abandon a draft');
	return setDraftStatusOwned(userId, walletId, draftId, 'abandoned', ['draft', 'signing']);
}

/** Lazy expiry sweep hook (called from the sync lane). */
export function sweepExpired(walletId?: number): number {
	return sweepExpiredDrafts(walletId);
}
