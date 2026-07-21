/**
 * Wallet-engine shared types (WALLET-ENGINE §2.1). The public shapes every
 * layer above the ScriptEngine seam speaks in. `kind` appears here as data;
 * only `script/engine.ts.selectEngine()` ever branches on it.
 */

export type WalletKind = 'single' | 'multisig';
export type SingleScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
export type MultisigScriptType = 'p2sh' | 'p2sh-p2wsh' | 'p2wsh';
export type ScriptType = SingleScriptType | MultisigScriptType;
export type ChainNetwork = 'mainnet' | 'testnet' | 'regtest';
export type DraftStatus =
	| 'draft'
	| 'signing'
	| 'broadcast'
	| 'confirmed'
	| 'abandoned'
	| 'superseded';

/** One `wallet_keys` row. */
export interface CosignerKey {
	position: number;
	xpub: string;
	fingerprint: string; // 8 lowercase hex; '00000000' if unknown
	path: string; // key-origin path, e.g. "m/84'/0'/0'"
	name?: string;
	category?: string;
	deviceType?: string | null;
	assignedUserId?: number | null;
}

export interface Wallet {
	id: number;
	userId: number;
	name: string;
	kind: WalletKind;
	scriptType: ScriptType;
	network: ChainNetwork;
	threshold: number; // M; N = keys.length
	descriptor: string | null;
	receiveCursor: number;
	changeCursor: number;
	source: 'created' | 'imported';
	keys: CosignerKey[];
	createdAt: string;
}

export interface WalletAddress {
	address: string;
	chain: 0 | 1;
	index: number;
	scripthash: string;
	scriptPubKey: string; // hex
	used: boolean;
	balanceSats: number;
	txCount: number;
}

export interface SpendableUtxo {
	txid: string;
	vout: number;
	valueSats: number;
	height: number; // 0 = unconfirmed
	address: string;
	chain: 0 | 1;
	index: number;
	coinbase?: boolean | 'unknown';
	unconfirmedTrust?: 'own-change' | 'received';
}

export interface Recipient {
	address: string;
	amountSats: number | 'max';
}

export interface SigningProgress {
	required: number;
	collected: number;
	complete: boolean;
	keys: { fingerprint: string; path: string; signed: boolean }[];
	inputCount: number;
}

export interface ReviewSummary {
	walletId: number;
	kind: WalletKind;
	recipients: { address: string; amountSats: number }[];
	changeAmountSats: number | null;
	feeSats: number;
	feeRate: number;
	vsize: number;
	inputs: { txid: string; vout: number; valueSats: number; address: string }[];
	totalInputSats: number;
	progress: SigningProgress;
}

export interface BuiltDraft {
	draftId: number;
	psbtBase64: string;
	review: ReviewSummary;
}

/** A history entry for the wallet detail page (SWR cache). */
export interface TxHistoryEntry {
	txid: string;
	height: number; // 0/-1 = unconfirmed
	blockTime: number | null;
	deltaSats: number; // +recv / -spend, net effect on this wallet
	feeSats: number | null; // null when a parent could not be resolved (never guessed)
}

/** A stored psbt_drafts row, service-layer shape (repo hydrates from SQL). */
export interface DraftRow {
	id: number;
	walletId: number;
	createdBy: number;
	status: DraftStatus;
	psbt: string; // base64 working PSBT -- NEVER returned to a Viewer (§5.3)
	txid: string | null;
	recipients: { address: string; amountSats: number }[];
	amountSats: number;
	feeSats: number;
	feeRate: number;
	changeIndex: number | null;
	replacesTxid: string | null;
	broadcastStartedAt: string | null;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

/** The Viewer-safe projection of a draft: no PSBT bytes, no raw inputs (§5.3). */
export interface RedactedDraft {
	id: number;
	walletId: number;
	status: DraftStatus;
	createdAt: string;
	redacted: true;
}
