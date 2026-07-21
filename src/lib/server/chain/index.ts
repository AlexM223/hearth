/**
 * Explorer read models -- blocks/tx/address/mempool/fees (DECISIONS.md
 * §4.2, §4.4; EXPLORER.md). Tiered richness by which rail (Electrum/Core)
 * answered; no third-party HTTP explorer API, ever. This file is the
 * module's PUBLIC SURFACE (EXPLORER.md §1.1) -- every route/other module
 * imports from here only, never reaching into chain/blocks.ts etc directly.
 */
export type {
	Richness,
	PoolAttribution,
	BlockSummary,
	BlockDetail,
	BlockTxRow,
	BlockTxPage,
	TxVin,
	TxVout,
	BlockContext,
	CpfpInfo,
	TxDetail,
	AddressView,
	AddressTxRow,
	AddressTxPage,
	MempoolSummary,
	FeeHistogramBucket,
	FeeRecommendation,
	SearchResultType,
	SearchResult
} from './types.js';
/** @deprecated pre-M4 alias -- use `Richness` from this module. */
export type { Richness as ExplorerRichness } from './types.js';

export { classifySearch, HEIGHT_RE, HEX64_RE, type SearchNode } from './search.js';
export { isDecodableAddress } from './address.js';
