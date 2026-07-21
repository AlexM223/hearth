/**
 * Wallet route access control (WALLET-ENGINE §5.3; DECISIONS.md §4.2, §4.3).
 * The Viewer/Guest boundary: a role that is not owner/cosigner NEVER sees a raw
 * PSBT. Two layers guard this -- the service layer (getWalletRow scopes to the
 * owner) and the route layer (these helpers). Heartwood shipped a viewer-sees-
 * raw-PSBT leak because "the gate existed but the route never called it"; here
 * the route handlers call resolveAccess() before returning anything PSBT-bearing.
 *
 * M2 note: wallets are owner-scoped (sharing/roles land in M3). So the M2 role
 * resolution is: owner (wallet.user_id === caller) => full; anyone else =>
 * 'none' (404, no leak). The DraftSummary redaction + role seam are built now so
 * M3 can grant Viewers the shared read tier without touching the money path.
 */
import type { DraftRow, RedactedDraft, Wallet } from './types.js';

export type WalletRole = 'owner' | 'viewer' | 'none';

/** A viewer-safe draft projection: NO psbt bytes, NO raw inputs (§5.3). */
export interface DraftSummary {
	id: number;
	walletId: number;
	status: DraftRow['status'];
	amountSats: number;
	feeSats: number;
	recipientCount: number;
	createdAt: string;
	updatedAt: string;
	txid: string | null;
}

/** Resolve the caller's role for a wallet. In M2 only the owner has access. */
export function resolveWalletRole(callerUserId: number, wallet: Wallet | null): WalletRole {
	if (!wallet) return 'none';
	if (wallet.userId === callerUserId) return 'owner';
	return 'none';
}

/** Redact a draft to the id/status only (a viewer may know it exists). */
export function redactDraft(draft: DraftRow): RedactedDraft {
	return {
		id: draft.id,
		walletId: draft.walletId,
		status: draft.status,
		createdAt: draft.createdAt,
		redacted: true
	};
}

/** A summary that still hides the PSBT bytes + raw inputs but shows the amounts
 *  (for an owner list view -- never sent to a 'none' role). */
export function draftSummary(draft: DraftRow): DraftSummary {
	return {
		id: draft.id,
		walletId: draft.walletId,
		status: draft.status,
		amountSats: draft.amountSats,
		feeSats: draft.feeSats,
		recipientCount: draft.recipients.length,
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt,
		txid: draft.txid
	};
}
