/**
 * The ONE unified wallet engine (DECISIONS.md §0 rule 3, §4.2, §4.9):
 * xpub/descriptor import, derivation, PSBT build -> review -> sign ->
 * commitment-check -> broadcast. "kind" is a data column, never a second
 * code path -- especially never a second broadcast path. Server-side only;
 * hardware wallets live in src/lib/hw (browser-side, WebHID/WebSerial) and are
 * never imported here (WALLET-ENGINE §0.3, §5.1).
 *
 * This file is the module's PUBLIC SURFACE -- the only file other modules import.
 */
export type {
	WalletKind,
	SingleScriptType,
	MultisigScriptType,
	ScriptType,
	ChainNetwork,
	DraftStatus,
	CosignerKey,
	Wallet,
	WalletAddress,
	SpendableUtxo,
	Recipient,
	SigningProgress,
	ReviewSummary,
	BuiltDraft,
	TxHistoryEntry,
	DraftRow,
	RedactedDraft
} from './types.js';

import type { Wallet, WalletAddress } from './types.js';
import { selectEngine } from './script/engine.js';
import { scriptToScripthash } from './derive.js';
import { hex } from '@scure/base';
import { getWalletRow, updateCursors } from './repo.js';
import { NotFoundError } from './errors.js';

/**
 * Derive `count` addresses on a chain starting at `fromIndex` (WALLET-ENGINE
 * §2.3). Pure/sync, ECC-free encoding. Single-sig derives one pubkey; multisig
 * derives N, BIP-67-sorts and builds sortedmulti -- all inside the ScriptEngine
 * (the only kind switch). balanceSats/txCount are 0 here; the scan fills them.
 */
export function deriveAddresses(
	wallet: Wallet,
	chain: 0 | 1,
	fromIndex: number,
	count: number
): WalletAddress[] {
	const engine = selectEngine(wallet);
	const out: WalletAddress[] = [];
	for (let i = 0; i < count; i++) {
		const index = fromIndex + i;
		const script = engine.scriptFor(chain, index);
		out.push({
			address: script.address,
			chain,
			index,
			scripthash: scriptToScripthash(script.scriptPubKey),
			scriptPubKey: hex.encode(script.scriptPubKey),
			used: false,
			balanceSats: 0,
			txCount: 0
		});
	}
	return out;
}

export { selectEngine } from './script/engine.js';

/** The next unused external address, rotating receive_cursor forward (§2.3). */
export function nextReceiveAddress(userId: number, walletId: number): WalletAddress {
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new NotFoundError('wallet not found');
	const index = wallet.receiveCursor;
	const [addr] = deriveAddresses(wallet, 0, index, 1);
	updateCursors(walletId, index + 1, wallet.changeCursor);
	return addr;
}

/**
 * The current receive address WITHOUT advancing `receive_cursor` (mining's
 * authTable.ts, readModels.ts: a payout/display address must never itself
 * consume the next receive slot -- only an actual `nextReceiveAddress` call
 * on block acceptance does that). Pure/sync -- derivation is ECC-free and
 * `receiveCursor` is already the DB-held source of truth, so no chain call is
 * needed to "peek" (unlike a reference implementation that derives the cursor
 * from live chain usage).
 */
export function peekReceiveAddress(wallet: Wallet): WalletAddress {
	const [addr] = deriveAddresses(wallet, 0, wallet.receiveCursor, 1);
	return addr;
}

export {
	resolveWalletRole,
	redactDraft,
	draftSummary,
	type WalletRole,
	type DraftSummary
} from './access.js';
export {
	WalletError,
	CommitmentError,
	InvalidRecipientError,
	InvalidPsbtError,
	InsufficientFundsError,
	InvalidFeeRateError,
	AlreadyBroadcastError,
	AlreadyReplacedError,
	ForbiddenError,
	NotFoundError,
	NotFullySignedError
} from './errors.js';

export {
	importWallet,
	getWallet,
	listWallets,
	deleteWallet,
	walletToDescriptor,
	parseDescriptor,
	type ImportInput
} from './import.js';
export {
	listAllWalletRows,
	getWalletRowUnscoped,
	highestUsedIndex,
	listWalletScriptPubKeys
} from './repo.js';

export {
	syncWallet,
	markWalletDirty,
	getBalance,
	getSnapshot,
	getHistory,
	getUtxos,
	type SyncNode,
	type WalletSnapshot
} from './sync.js';
export { scanWallet, GAP_LIMIT, type ScanRail, type ScanResult } from './scan.js';

export {
	buildPsbt,
	reviewSummary,
	assertSameTransaction,
	applySignature,
	type BuildNode,
	type BuildRequest
} from './psbt.js';
export { broadcastDraft, type BroadcastNode, type BroadcastResult } from './broadcast.js';
export { listDraftRows as listDrafts, getDraftRow as getDraft } from './repo.js';
export {
	verifyTxInclusion,
	bitsToTarget,
	parseBlockHeader,
	meetsTarget,
	type SpvResult,
	type TxInclusionInput,
	type ParsedBlockHeader
} from './spv.js';
export { confirmDraft, type ConfirmNode } from './confirm.js';
export {
	selectCoins,
	dustThreshold,
	outputVsize,
	changeKind,
	bip69SortInputs,
	bip69SortOutputs,
	COINBASE_MATURITY,
	MAX_FEE_RATE
} from './select.js';
export { decodeAddress, isValidAddress, type OutputKind } from './address.js';
export {
	reservedOutpoints,
	reservationWarnings,
	abandonDraft,
	sweepExpired,
	type ReservationWarning
} from './reserve.js';
