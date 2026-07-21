/**
 * Transaction read model (EXPLORER.md §1.5): getTxDetail (prevout
 * resolution capped at MAX_PREVOUT_RESOLVE, block context, CPFP) and
 * getCpfpInfo (Core-only, adapted from nodeview's cpfp.ts).
 */
import {
	getRawTransaction,
	getBlockHeader,
	getTxOut,
	getMempoolEntry,
	getMempoolAncestors,
	getMempoolDescendants,
	type RpcCaller,
	type RawTransaction,
	type MempoolEntry
} from '../node/core/rpc.js';
import { resolvePrevouts, prevoutKey } from './prevout.js';
import { getBlockPoolAttribution } from './pool.js';
import { txDetailCache } from './cache.js';
import type { BlockContext, CpfpInfo, TxDetail, TxVin, TxVout } from './types.js';

/** A direct port of nodeview's guard: caps how many DISTINCT parent txs a
 *  single tx-detail view will fetch. Beyond the cap, fee/feeRate are both
 *  null -- never a partial/misleading fee (§1.2's cardinal rule). */
export const MAX_PREVOUT_RESOLVE = 60;
/** Bounds the per-output `gettxout` fan-out for the spent/unspent dot on a
 *  pathological many-output tx (e.g. an exchange consolidation). Beyond the
 *  cap, `spent` stays null (unknown) rather than adding an unbounded fan-out
 *  to a single page view -- the same cost-discipline EXPLORER.md applies to
 *  prevout/address caps, applied here too. */
export const MAX_SPENT_CHECK_OUTPUTS = 100;

export interface TxNode {
	coreRpc: RpcCaller;
	getTipHeight(): Promise<number | null>;
}

function isCoinbaseTx(tx: RawTransaction): boolean {
	return tx.vin.length === 1 && typeof tx.vin[0].coinbase === 'string';
}

function isSegwit(tx: RawTransaction): boolean {
	return tx.vin.some((v) => Array.isArray(v.txinwitness) && v.txinwitness.length > 0);
}

function isRbfSignaled(tx: RawTransaction): boolean {
	return tx.vin.some((v) => v.sequence < 0xfffffffe);
}

async function resolveVin(rpc: RpcCaller, tx: RawTransaction): Promise<{ vin: TxVin[]; feeInputsResolved: boolean }> {
	if (isCoinbaseTx(tx)) {
		const v = tx.vin[0];
		return {
			vin: [
				{
					txid: null,
					vout: null,
					coinbase: true,
					address: null,
					value: null,
					scriptSigHex: v.scriptSig?.hex ?? null,
					witness: v.txinwitness ?? null
				}
			],
			feeInputsResolved: false // a coinbase has no "fee" -- never computed
		};
	}

	if (tx.vin.length > MAX_PREVOUT_RESOLVE) {
		// Over the cap -- never attempt a partial sum; fee/feeRate stay null.
		const vin = tx.vin.map(
			(v): TxVin => ({
				txid: v.txid ?? null,
				vout: v.vout ?? null,
				coinbase: false,
				address: null,
				value: null,
				scriptSigHex: v.scriptSig?.hex ?? null,
				witness: v.txinwitness ?? null
			})
		);
		return { vin, feeInputsResolved: false };
	}

	const refs = tx.vin
		.filter((v) => v.txid && v.vout !== undefined)
		.map((v) => ({ txid: v.txid!, vout: v.vout! }));
	const resolved = await resolvePrevouts(rpc, refs);
	const allResolved = refs.length === tx.vin.length && refs.every((r) => resolved.has(prevoutKey(r)));

	const vin: TxVin[] = tx.vin.map((v) => {
		const key = v.txid && v.vout !== undefined ? prevoutKey({ txid: v.txid, vout: v.vout }) : null;
		const r = key ? resolved.get(key) : undefined;
		return {
			txid: v.txid ?? null,
			vout: v.vout ?? null,
			coinbase: false,
			address: r?.address ?? null,
			value: r?.value ?? null,
			scriptSigHex: v.scriptSig?.hex ?? null,
			witness: v.txinwitness ?? null
		};
	});
	return { vin, feeInputsResolved: allResolved };
}

async function resolveVout(rpc: RpcCaller, txid: string, tx: RawTransaction): Promise<TxVout[]> {
	return Promise.all(
		tx.vout.map(async (o, n): Promise<TxVout> => {
			let spent: boolean | null = null;
			if (n < MAX_SPENT_CHECK_OUTPUTS) {
				try {
					const utxo = await getTxOut(rpc, txid, n, true);
					spent = utxo === null;
				} catch {
					spent = null;
				}
			}
			return {
				address: o.scriptPubKey.address ?? null,
				value: Math.round(o.value * 1e8),
				scriptType: o.scriptPubKey.type,
				scriptPubKeyHex: o.scriptPubKey.hex,
				spent
			};
		})
	);
}

function buildBlockContext(
	confirmed: boolean,
	height: number | null,
	confirmations: number,
	tipHeight: number | null
): BlockContext {
	if (!confirmed) {
		return { richness: 'basic', confirmed: false, height: null, confirmations: 0, tipHeight };
	}
	if (height !== null && tipHeight !== null) {
		return { richness: 'full', confirmed: true, height, confirmations, tipHeight };
	}
	if (height !== null) {
		return { richness: 'basic', confirmed: true, height, confirmations, tipHeight: null };
	}
	return { richness: 'basic', confirmed: true, height: null, confirmations, tipHeight };
}

/**
 * `getmempoolentry` fails fast (rejects) for a confirmed/unknown tx -- the
 * caller never bothers with ancestor/descendant calls in that case.
 * `effectiveFeeRate` = total fee / total vsize over {self, ancestors,
 * descendants}. `boostedByDescendant`/`bumpsAncestor` are gated by a
 * "meaningfully different" threshold (>= 0.1 sat/vB AND >= 1% of the tx's
 * own rate) so floating-point/rounding noise never flips the badge.
 */
export async function getCpfpInfo(node: TxNode, txid: string): Promise<CpfpInfo | null> {
	let entry;
	try {
		entry = await getMempoolEntry(node.coreRpc, txid);
	} catch {
		return null; // not in mempool (confirmed, or unknown), or Core is down
	}

	let ancestors: Record<string, MempoolEntry> = {};
	let descendants: Record<string, MempoolEntry> = {};
	try {
		ancestors = await getMempoolAncestors(node.coreRpc, txid, true);
	} catch {
		ancestors = {};
	}
	try {
		descendants = await getMempoolDescendants(node.coreRpc, txid, true);
	} catch {
		descendants = {};
	}

	const ownFeeSats = Math.round(entry.fees.base * 1e8);
	const ownFeeRate = ownFeeSats / entry.vsize;

	const ancestorEntries = Object.values(ancestors);
	const descendantEntries = Object.values(descendants);

	const sumFeeSats = (entries: MempoolEntry[]) => entries.reduce((s, e) => s + Math.round(e.fees.base * 1e8), 0);
	const sumVsize = (entries: MempoolEntry[]) => entries.reduce((s, e) => s + e.vsize, 0);

	const totalFeeSats = ownFeeSats + sumFeeSats(ancestorEntries) + sumFeeSats(descendantEntries);
	const totalVsize = entry.vsize + sumVsize(ancestorEntries) + sumVsize(descendantEntries);
	const effectiveFeeRate = totalVsize > 0 ? totalFeeSats / totalVsize : ownFeeRate;

	const threshold = Math.max(0.1, ownFeeRate * 0.01);

	const ancestorCount = ancestorEntries.length;
	const descendantCount = descendantEntries.length;

	const ancestorAvgRate = ancestorCount > 0 ? sumFeeSats(ancestorEntries) / sumVsize(ancestorEntries) : null;
	const descendantAvgRate =
		descendantCount > 0 ? sumFeeSats(descendantEntries) / sumVsize(descendantEntries) : null;

	const bumpsAncestor = ancestorAvgRate !== null && ownFeeRate - ancestorAvgRate >= threshold;
	const boostedByDescendant = descendantAvgRate !== null && descendantAvgRate - ownFeeRate >= threshold;

	return {
		inMempool: true,
		ownFeeRate,
		effectiveFeeRate,
		boostedByDescendant,
		bumpsAncestor,
		ancestorCount,
		descendantCount
	};
}

/**
 * Tx detail (EXPLORER.md §1.5). `viewerUserId` scopes only `pool.isYou`
 * (matching blocks.ts's cache discipline, §2) -- everything else is cached
 * txid-keyed and shared, ONLY once `confirmations >= 1` (an unconfirmed tx's
 * CPFP/RBF context changes every block).
 */
export async function getTxDetail(
	node: TxNode,
	txid: string,
	viewerUserId: number | null = null
): Promise<TxDetail> {
	const cached = txDetailCache.get(txid);
	if (cached) return cached;

	const tx = await getRawTransaction(node.coreRpc, txid, true);
	const tip = await node.getTipHeight();

	const confirmed = !!tx.blockhash;
	let blockHeight: number | null = null;
	if (confirmed) {
		try {
			const header = await getBlockHeader(node.coreRpc, tx.blockhash!);
			blockHeight = header.height;
		} catch {
			blockHeight = null;
		}
	}
	const confirmations = tx.confirmations ?? 0;

	const { vin, feeInputsResolved } = await resolveVin(node.coreRpc, tx);
	const vout = await resolveVout(node.coreRpc, txid, tx);

	const totalOut = Math.round(tx.vout.reduce((s, o) => s + o.value, 0) * 1e8);
	let fee: number | null = null;
	let feeRate: number | null = null;
	if (!isCoinbaseTx(tx) && feeInputsResolved) {
		const totalIn = vin.reduce((s, v) => s + (v.value ?? 0), 0);
		fee = totalIn - totalOut;
		feeRate = fee / tx.vsize;
	}

	const blockContext = buildBlockContext(confirmed, blockHeight, confirmations, tip);
	const cpfp = confirmed ? null : await getCpfpInfo(node, txid);

	let pool = null;
	if (isCoinbaseTx(tx) && confirmed && tx.blockhash) {
		pool = getBlockPoolAttribution(tx.blockhash, viewerUserId);
	}

	const detail: TxDetail = {
		txid: tx.txid,
		confirmed,
		blockHeight,
		blockHash: tx.blockhash ?? null,
		blockTime: tx.blocktime ?? null,
		confirmations,
		size: tx.size,
		vsize: tx.vsize,
		weight: tx.weight,
		locktime: tx.locktime,
		version: tx.version,
		segwit: isSegwit(tx),
		rbf: isRbfSignaled(tx),
		fee,
		feeRate,
		vin,
		vout,
		blockContext,
		cpfp,
		pool
	};

	if (confirmations >= 1) txDetailCache.set(txid, detail);
	return detail;
}
