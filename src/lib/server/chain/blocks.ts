/**
 * Block read models (EXPLORER.md §1.4): listRecentBlocks / getBlockDetail /
 * getBlockTxPage. Electrum headers are the free/primary source for the
 * list; Core enriches per row with `Promise.allSettled` at ROW grain (one
 * bad row never blanks the list). `pool` attribution is resolved fresh per
 * call (never baked into a cached row -- `isYou` is viewer-scoped and the
 * cache is shared across every viewer, §2).
 *
 * Cache note: `blockDetailCache` is shared between the list view's cheaper
 * (50-sample) enrichment and the single-block detail view's fuller
 * (400-sample) enrichment -- whichever populates a given hash first "wins"
 * and is served to both call sites afterward (the cache never re-computes a
 * hash it already has, §1.8's "immutable once fetched"). Both are already a
 * documented approximation (never a fabricated exact value), so this is a
 * quality tradeoff, not a correctness one.
 */
import {
	getBlock,
	getBlockHash,
	getBlockHeader,
	getRawTransaction,
	type RpcCaller,
	type BlockVerbose2,
	type RawTransaction
} from '../node/core/rpc.js';
import { decodeBlockHeader, decodeBlockHeaderRange } from './decode.js';
import { blockDetailCache, blockTxIdsCache } from './cache.js';
import { getBlockPoolAttribution } from './pool.js';
import { resolvePrevouts, prevoutKey } from './prevout.js';
import type { BlockDetail, BlockSummary, BlockTxPage, BlockTxRow } from './types.js';

/** The list view's per-row fee sample cap. DEVIATION from EXPLORER.md §1.4's
 *  literal "400" (that cap is kept for the single-block DETAIL view,
 *  `DETAIL_FEE_SAMPLE_CAP` below): sampling 400 txs' PREVOUTS for every one
 *  of ~10 rows on the index page (a live, frequently-refreshed page) would
 *  fan out thousands of RPC calls on every load. 50 keeps the list glanceable
 *  while still giving a representative fee-rate sample; documented here per
 *  this doc's own license to fix-forward a genuine cost defect (header note,
 *  §0's "answer the hardest question" spirit applied to a perf footgun). */
const LIST_FEE_SAMPLE_CAP = 50;
/** The single-block detail view's per-tx fee pass cap -- matches EXPLORER.md
 *  §1.4's literal text; a one-time cost for a page the viewer explicitly
 *  navigated to, not a page-load-every-few-seconds surface. */
const DETAIL_FEE_SAMPLE_CAP = 400;

export interface BlocksElectrumRail {
	isConnected: boolean;
	getBlockHeader(height: number): Promise<string>;
	getBlockHeaders(startHeight: number, count: number): Promise<{ hex: string; count: number; max: number }>;
}

export interface BlocksNode {
	electrum: BlocksElectrumRail;
	coreRpc: RpcCaller;
	getTipHeight(): Promise<number | null>;
}

function isCoinbase(tx: RawTransaction): boolean {
	return tx.vin.length === 1 && typeof tx.vin[0].coinbase === 'string';
}

function median(sorted: number[]): number {
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface FeeStats {
	medianFeeRate: number | null;
	feeRateRange: [number, number] | null;
}

/** The "light per-tx pass" (§1.4): resolves prevouts for up to `cap`
 *  non-coinbase txs and derives sat/vB per tx. A documented approximation,
 *  not a lie -- the type comment on BlockSummary already says so. */
async function computeFeeStats(rpc: RpcCaller, txs: RawTransaction[], cap: number): Promise<FeeStats> {
	const sample = txs.filter((tx) => !isCoinbase(tx)).slice(0, cap);
	if (sample.length === 0) return { medianFeeRate: null, feeRateRange: null };

	const refs = sample.flatMap((tx) =>
		tx.vin.filter((v) => v.txid && v.vout !== undefined).map((v) => ({ txid: v.txid!, vout: v.vout! }))
	);
	const resolved = await resolvePrevouts(rpc, refs);

	const rates: number[] = [];
	for (const tx of sample) {
		let totalIn = 0;
		let allResolved = tx.vin.length > 0;
		for (const vin of tx.vin) {
			if (!vin.txid || vin.vout === undefined) {
				allResolved = false;
				break;
			}
			const r = resolved.get(prevoutKey({ txid: vin.txid, vout: vin.vout }));
			if (!r) {
				allResolved = false;
				break;
			}
			totalIn += r.value;
		}
		if (!allResolved) continue;
		const totalOut = Math.round(tx.vout.reduce((s, o) => s + o.value, 0) * 1e8);
		const fee = totalIn - totalOut;
		if (fee < 0) continue; // never a negative "fee" -- a decode inconsistency, skip the sample point
		rates.push(fee / tx.vsize);
	}
	if (rates.length === 0) return { medianFeeRate: null, feeRateRange: null };
	rates.sort((a, b) => a - b);
	return { medianFeeRate: median(rates), feeRateRange: [rates[0], rates[rates.length - 1]] };
}

function coinbaseRewardSats(txs: RawTransaction[]): number | null {
	const coinbase = txs.find(isCoinbase);
	if (!coinbase) return null;
	return Math.round(coinbase.vout.reduce((s, o) => s + o.value, 0) * 1e8);
}

/** Builds the pool-agnostic (pool always null -- attached per-call, per
 *  viewer, by the public functions below) parts of a BlockDetail. */
async function buildFullDetail(
	node: BlocksNode,
	hash: string,
	tip: number | null,
	feeSampleCap: number
): Promise<Omit<BlockDetail, 'pool'>> {
	const block: BlockVerbose2 = await getBlock(node.coreRpc, hash, 2);
	const feeStats = await computeFeeStats(node.coreRpc, block.tx, feeSampleCap);
	return {
		height: block.height,
		hash: block.hash,
		time: block.time,
		txCount: block.tx.length,
		size: block.size,
		weight: block.weight,
		medianFeeRate: feeStats.medianFeeRate,
		feeRateRange: feeStats.feeRateRange,
		reward: coinbaseRewardSats(block.tx),
		richness: 'full',
		prevHash: block.previousblockhash ?? null,
		nextHash: block.nextblockhash ?? null,
		merkleRoot: block.merkleroot,
		nonce: block.nonce,
		bits: block.bits,
		version: block.version,
		versionHex: block.versionHex,
		difficulty: block.difficulty,
		chainwork: block.chainwork,
		confirmations: tip !== null ? tip - block.height + 1 : block.confirmations
	};
}

function isHeightInput(v: string | number): boolean {
	if (typeof v === 'number') return true;
	return /^\d+$/.test(v);
}

/**
 * Block detail by hash OR height (EXPLORER.md §1.3/§1.4's two distinct
 * degrade paths). `viewerUserId` scopes ONLY the `pool.isYou` field --
 * everything else is cached hash-keyed and shared across every viewer.
 */
export async function getBlockDetail(
	node: BlocksNode,
	hashOrHeight: string | number,
	viewerUserId: number | null = null
): Promise<BlockDetail> {
	const byHeight = isHeightInput(hashOrHeight);

	if (byHeight) {
		const height = Number(hashOrHeight);
		try {
			const hash = await getBlockHash(node.coreRpc, height);
			return await detailByHash(node, hash, viewerUserId);
		} catch {
			// Core down (or height doesn't exist yet) -- Electrum bare-header
			// fallback: hash/time/prevHash/merkleRoot/bits/nonce/version only,
			// richness 'basic' (EXPLORER.md §1.3's height-lookup row).
			try {
				const headerHex = await node.electrum.getBlockHeader(height);
				const h = decodeBlockHeader(headerHex);
				return {
					height,
					hash: h.hash,
					time: h.time,
					txCount: null,
					size: null,
					weight: null,
					medianFeeRate: null,
					feeRateRange: null,
					reward: null,
					richness: 'basic',
					pool: getBlockPoolAttribution(h.hash, viewerUserId),
					prevHash: h.prevHash,
					nextHash: null,
					merkleRoot: h.merkleRoot,
					nonce: h.nonce,
					bits: h.bits,
					version: h.version,
					versionHex: (h.version >>> 0).toString(16).padStart(8, '0'),
					difficulty: null,
					chainwork: null,
					confirmations: null
				};
			} catch {
				return noneBlock(height, null);
			}
		}
	}

	const hash = String(hashOrHeight);
	try {
		return await detailByHash(node, hash, viewerUserId);
	} catch {
		// EXPLORER.md §1.3: hash lookups have NO Electrum fallback (no hash->
		// height index) -- richness 'none', never a silent 404.
		return noneBlock(null, hash);
	}
}

async function detailByHash(node: BlocksNode, hash: string, viewerUserId: number | null): Promise<BlockDetail> {
	const cached = blockDetailCache.get(hash);
	if (cached) return { ...cached, pool: getBlockPoolAttribution(hash, viewerUserId) };

	const tip = await node.getTipHeight();
	const detail = await buildFullDetail(node, hash, tip, DETAIL_FEE_SAMPLE_CAP);
	blockDetailCache.set(hash, detail);
	return { ...detail, pool: getBlockPoolAttribution(hash, viewerUserId) };
}

function noneBlock(height: number | null, hash: string | null): BlockDetail {
	return {
		height: height ?? -1,
		hash: hash ?? '',
		time: 0,
		txCount: null,
		size: null,
		weight: null,
		medianFeeRate: null,
		feeRateRange: null,
		reward: null,
		richness: 'none',
		pool: null,
		prevHash: null,
		nextHash: null,
		merkleRoot: '',
		nonce: 0,
		bits: '',
		version: 0,
		versionHex: '',
		difficulty: null,
		chainwork: null,
		confirmations: null
	};
}

interface HeaderRow {
	height: number;
	hash: string;
	time: number;
}

async function fetchHeaderRows(node: BlocksNode, startHeight: number, count: number): Promise<HeaderRow[]> {
	if (node.electrum.isConnected) {
		try {
			const { hex } = await node.electrum.getBlockHeaders(startHeight, count);
			const rows = decodeBlockHeaderRange(hex, startHeight);
			if (rows.length > 0) return rows.map((r) => ({ height: r.height, hash: r.hash, time: r.time }));
		} catch {
			// fall through to the Core fallback below
		}
	}
	const heights = Array.from({ length: count }, (_, i) => startHeight + i);
	const settled = await Promise.allSettled(
		heights.map(async (height): Promise<HeaderRow> => {
			const hash = await getBlockHash(node.coreRpc, height);
			// Cheap JSON header (not the full verbosity-2 tx decode) just for
			// `time` -- the honest-null rule means we never fabricate 0 here.
			const header = await getBlockHeader(node.coreRpc, hash);
			return { height, hash, time: header.time };
		})
	);
	return settled.filter((r): r is PromiseFulfilledResult<HeaderRow> => r.status === 'fulfilled').map((r) => r.value);
}

async function enrichRow(node: BlocksNode, row: HeaderRow, viewerUserId: number | null): Promise<BlockSummary> {
	const cached = blockDetailCache.get(row.hash);
	if (cached) return { ...cached, pool: getBlockPoolAttribution(row.hash, viewerUserId) };

	try {
		const tip = await node.getTipHeight();
		const detail = await buildFullDetail(node, row.hash, tip, LIST_FEE_SAMPLE_CAP);
		blockDetailCache.set(row.hash, detail);
		return { ...detail, pool: getBlockPoolAttribution(row.hash, viewerUserId) };
	} catch {
		// Core enrichment failed -- the row stays richness:'basic' with only
		// hash/time/height (EXPLORER.md §1.3's "Block enrichment" row).
		return {
			height: row.height,
			hash: row.hash,
			time: row.time,
			txCount: null,
			size: null,
			weight: null,
			medianFeeRate: null,
			feeRateRange: null,
			reward: null,
			richness: 'basic',
			pool: getBlockPoolAttribution(row.hash, viewerUserId)
		};
	}
}

async function listBlocksInRange(
	node: BlocksNode,
	startHeight: number,
	endHeight: number,
	viewerUserId: number | null
): Promise<BlockSummary[]> {
	if (endHeight < startHeight) return [];
	const rangeCount = endHeight - startHeight + 1;
	const headerRows = await fetchHeaderRows(node, startHeight, rangeCount);
	headerRows.sort((a, b) => b.height - a.height); // newest first

	const settled = await Promise.allSettled(headerRows.map((row) => enrichRow(node, row, viewerUserId)));
	return settled
		.filter((r): r is PromiseFulfilledResult<BlockSummary> => r.status === 'fulfilled')
		.map((r) => r.value);
}

/**
 * The last `count` blocks, newest first. Each row enriches independently
 * (`Promise.allSettled` at ROW grain) so one bad row never blanks the list.
 */
export async function listRecentBlocks(
	node: BlocksNode,
	count = 10,
	viewerUserId: number | null = null
): Promise<BlockSummary[]> {
	const tip = await node.getTipHeight();
	if (tip === null) return [];
	const startHeight = Math.max(0, tip - count + 1);
	return listBlocksInRange(node, startHeight, tip, viewerUserId);
}

/**
 * The `limit` blocks strictly before `beforeHeight`, newest first -- backs
 * the "see all" full paginated block list (§4.1's `/explorer/blocks`) and
 * `GET /api/chain/blocks?before=&limit=` (§4.2).
 */
export async function listBlocksBefore(
	node: BlocksNode,
	beforeHeight: number,
	limit = 25,
	viewerUserId: number | null = null
): Promise<BlockSummary[]> {
	const endHeight = beforeHeight - 1;
	if (endHeight < 0) return [];
	const startHeight = Math.max(0, endHeight - limit + 1);
	return listBlocksInRange(node, startHeight, endHeight, viewerUserId);
}

/**
 * A block's tx list, paginated (EXPLORER.md §1.4): the ordered txid[] is
 * fetched once and cached (immutable once the block has enough
 * confirmations that a reorg pushing it out is not a live concern for this
 * feature -- in practice: cached unconditionally, since a reorg would swap
 * the whole hash and this cache is hash-keyed, never height-keyed). Only
 * `txids.slice(cursor, cursor+limit)` gets resolved per call.
 */
export async function getBlockTxPage(
	node: BlocksNode,
	hash: string,
	cursor = 0,
	limit = 25
): Promise<BlockTxPage> {
	let txids = blockTxIdsCache.get(hash);
	if (!txids) {
		const block = await getBlock(node.coreRpc, hash, 1);
		txids = block.tx;
		blockTxIdsCache.set(hash, txids);
	}

	const pageIds = txids.slice(cursor, cursor + limit);
	const settled = await Promise.allSettled(pageIds.map((txid) => resolveTxRow(node, txid)));
	const rows: BlockTxRow[] = settled.map((r, i) =>
		r.status === 'fulfilled' ? r.value : { txid: pageIds[i], feeRate: null, totalOut: null }
	);

	return {
		txids,
		rows,
		cursor: cursor + pageIds.length,
		hasMore: cursor + pageIds.length < txids.length
	};
}

async function resolveTxRow(node: BlocksNode, txid: string): Promise<BlockTxRow> {
	const tx = await getRawTransaction(node.coreRpc, txid);
	const totalOut = Math.round(tx.vout.reduce((s, o) => s + o.value, 0) * 1e8);
	if (isCoinbase(tx)) return { txid, feeRate: null, totalOut };

	const refs = tx.vin
		.filter((v) => v.txid && v.vout !== undefined)
		.map((v) => ({ txid: v.txid!, vout: v.vout! }));
	const resolved = await resolvePrevouts(node.coreRpc, refs);
	let totalIn = 0;
	let allResolved = refs.length === tx.vin.length && refs.length > 0;
	for (const ref of refs) {
		const r = resolved.get(prevoutKey(ref));
		if (!r) {
			allResolved = false;
			break;
		}
		totalIn += r.value;
	}
	const feeRate = allResolved ? (totalIn - totalOut) / tx.vsize : null;
	return { txid, feeRate, totalOut };
}
