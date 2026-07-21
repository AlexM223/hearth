/**
 * Shared explorer read-model types (EXPLORER.md §1.2). The cardinal rule,
 * ported from cairn verbatim as policy: an unknown field is `null`, NEVER a
 * fabricated `0`. A `0`-value fee/size/count must always mean "confirmed to
 * be zero," not "we didn't ask." Enforced by the degrade-tier tests (§6).
 */

export type Richness = 'none' | 'basic' | 'full';

export interface PoolAttribution {
	height: number;
	blockHash: string;
	finderDisplayName: string;
	isYou: boolean;
	foundAt: string;
}

export interface BlockSummary {
	height: number;
	hash: string;
	time: number;
	txCount: number | null;
	size: number | null;
	weight: number | null;
	medianFeeRate: number | null;
	feeRateRange: [number, number] | null; // sat/vB
	reward: number | null; // sats, subsidy + fees
	richness: Richness;
	pool: PoolAttribution | null; // "you found this" -- never a third-party pool guess
}

export interface BlockDetail extends BlockSummary {
	prevHash: string | null;
	nextHash: string | null;
	merkleRoot: string;
	nonce: number;
	bits: string;
	version: number;
	versionHex: string;
	difficulty: number;
	chainwork: string;
	confirmations: number;
}

export interface BlockTxRow {
	txid: string;
	feeRate: number | null;
	totalOut: number | null;
}

/** A page of a block's transactions -- never resolve a whole big block's txs eagerly. */
export interface BlockTxPage {
	txids: string[]; // the full ordered list is cheap (verbosity-1 getblock)
	rows: BlockTxRow[]; // only THIS page's rows are resolved (§1.4)
	cursor: number; // index into txids to resume from
	hasMore: boolean;
}

export interface TxVin {
	txid: string | null;
	vout: number | null;
	coinbase: boolean;
	address: string | null;
	value: number | null;
	scriptSigHex: string | null;
	witness: string[] | null; // Advanced-only in the UI
}

export interface TxVout {
	address: string | null;
	value: number;
	scriptType: string;
	scriptPubKeyHex: string;
	spent: boolean | null; // null = unknown (needs Core gettxout)
}

/** Tiered "where does this tx sit" widget -- the tx page's block-rail summary. */
export interface BlockContext {
	richness: Richness;
	confirmed: boolean;
	height: number | null;
	confirmations: number | null;
	tipHeight: number | null;
}

export interface CpfpInfo {
	inMempool: boolean;
	ownFeeRate: number;
	effectiveFeeRate: number; // package rate over self+ancestors+descendants
	boostedByDescendant: boolean;
	bumpsAncestor: boolean;
	ancestorCount: number;
	descendantCount: number;
}

export interface TxDetail {
	txid: string;
	confirmed: boolean;
	blockHeight: number | null;
	blockHash: string | null;
	blockTime: number | null;
	confirmations: number;
	size: number;
	vsize: number;
	weight: number;
	locktime: number;
	version: number;
	segwit: boolean;
	rbf: boolean;
	fee: number | null;
	feeRate: number | null; // null if ANY prevout over the cap unresolved (§1.5)
	vin: TxVin[];
	vout: TxVout[];
	blockContext: BlockContext;
	cpfp: CpfpInfo | null; // null once confirmed, or when Core is absent
	pool: PoolAttribution | null; // set only when this tx IS the coinbase of a household-found block
}

export interface AddressView {
	address: string;
	scriptType: string | null;
	confirmedSats: number;
	unconfirmedSats: number;
	txCount: number | null; // null only in the scantxoutset degrade path (§1.6)
	richness: Richness;
	historyAvailable: boolean; // false in the scantxoutset degrade path
}

export interface AddressTxRow {
	txid: string;
	height: number;
	time: number | null; // height 0 = mempool
	deltaSats: number | null; // signed; null if detail truncated (§1.6)
	feeRate: number | null;
}

export interface AddressTxPage {
	rows: AddressTxRow[];
	cursor: string | null; // next cursor = last row's txid, or null at the end
	hasMore: boolean;
	detailTruncated: boolean; // true beyond ADDR_DETAIL_CAP (§1.6)
}

export interface MempoolSummary {
	txCount: number | null;
	bytes: number | null;
	totalFeeSats: number | null; // Core rail
	richness: Richness;
}

/** Highest feeRate first. */
export type FeeHistogramBucket = { feeRate: number; vsize: number };

export interface FeeRecommendation {
	satPerVb: number; // the ONE glanceable number
	caption: string; // "confirms in the next block, about 10 minutes"
	tiers: { label: string; satPerVb: number }[]; // fastest/30min/1hr/economy -- behind "show more"
	richness: Richness;
}

export type SearchResultType = 'block' | 'tx' | 'address' | 'unknown';
export interface SearchResult {
	type: SearchResultType;
	value: string; // height, hash, txid, or address as routed
}
