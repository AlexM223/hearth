/**
 * Address view + pagination (EXPLORER.md §1.6). Pure scripthash lookup --
 * NO wallet import, ever -- reusing the same `node/electrum/scripthash.js`
 * decoding the wallet module already uses, so address decoding logic is
 * never duplicated between modules.
 */
import {
	addressToScriptHash,
	addressToScriptPubKey,
	getRawTransaction,
	type RpcCaller,
	type RawTransaction,
	type ScanTxOutResult,
	type ElectrumBalance,
	type ElectrumHistoryItem
} from '../node/index.js';
import { resolvePrevouts, prevoutKey, type PrevoutRef } from './prevout.js';
import { addressHistoryCache } from './cache.js';
import type { AddressTxPage, AddressTxRow, AddressView } from './types.js';

/** ECC-free decode probe -- true iff `addressToScriptPubKey` can build a
 *  scriptPubKey from `v` without throwing. No new decoding logic (§1.7). */
export function isDecodableAddress(v: string): boolean {
	try {
		addressToScriptPubKey(v);
		return true;
	} catch {
		return false;
	}
}

export { addressToScriptHash };

/** Per-tx detail (deltaSats/feeRate) is only hydrated for rows within this
 *  many entries of the full history (nodeview's cap, sized up slightly). */
export const ADDR_DETAIL_CAP = 200;
/** Distinct prevout fetches for detail hydration, deduped across the whole
 *  page -- exactly like tx-detail's own MAX_PREVOUT_RESOLVE cap. */
export const ADDR_PREVOUT_CAP = 300;

export interface AddressElectrumRail {
	getBalance(scripthash: string): Promise<ElectrumBalance>;
	getHistory(scripthash: string): Promise<ElectrumHistoryItem[]>;
}

export interface AddressCoreRail extends RpcCaller {
	scanTxOutSet(action: string, descriptors: Array<string | { desc: string }>): Promise<ScanTxOutResult>;
}

export interface AddressNode {
	electrum: AddressElectrumRail;
	coreRpc: AddressCoreRail;
}

function classifyScriptType(script: Buffer): string {
	if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9) return 'p2pkh';
	if (script.length === 23 && script[0] === 0xa9) return 'p2sh';
	if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh';
	if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return 'p2wsh';
	if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr';
	return 'unknown';
}

function isCoinbase(tx: RawTransaction): boolean {
	return tx.vin.length === 1 && typeof tx.vin[0].coinbase === 'string';
}

/** TTL 10s per scripthash (§1.8) -- consecutive "load more" clicks on the
 *  same address don't re-fetch Electrum's full (unpaginated) history array
 *  every click. */
async function getCachedHistory(node: AddressNode, scripthash: string): Promise<ElectrumHistoryItem[]> {
	const cached = addressHistoryCache.get(scripthash);
	if (cached) return cached;
	const history = await node.electrum.getHistory(scripthash);
	addressHistoryCache.set(scripthash, history);
	return history;
}

/**
 * `addressToScriptHash` -> `scripthash.get_balance`, run INDEPENDENTLY of
 * history (a slow/oversized history must never blank a working balance).
 * Electrum down -> Core `scantxoutset` fallback: balance FLOOR only (current
 * UTXO set, no history). Both rails down -> throws (the page's OWN
 * richness:'none' empty state renders it, matching tx.ts/search.ts's
 * pattern -- there is no honest non-fabricated 0 to return here).
 */
export async function getAddressView(node: AddressNode, address: string): Promise<AddressView> {
	const scripthash = addressToScriptHash(address);
	const scriptType = classifyScriptType(addressToScriptPubKey(address));

	try {
		const balance = await node.electrum.getBalance(scripthash);
		let txCount: number | null = null;
		try {
			const history = await getCachedHistory(node, scripthash);
			txCount = history.length;
		} catch {
			txCount = null;
		}
		return {
			address,
			scriptType,
			confirmedSats: balance.confirmed,
			unconfirmedSats: balance.unconfirmed,
			txCount,
			richness: txCount !== null ? 'full' : 'basic',
			historyAvailable: txCount !== null
		};
	} catch {
		const result = await node.coreRpc.scanTxOutSet('start', [{ desc: `addr(${address})` }]);
		return {
			address,
			scriptType,
			confirmedSats: Math.round(result.total_amount * 1e8),
			unconfirmedSats: 0, // scantxoutset only ever sees the confirmed UTXO set
			txCount: null,
			richness: 'basic',
			historyAvailable: false
		};
	}
}

function sortHistoryNewestFirst(history: ElectrumHistoryItem[]): ElectrumHistoryItem[] {
	return [...history].sort((a, b) => {
		const aMempool = a.height <= 0;
		const bMempool = b.height <= 0;
		if (aMempool !== bMempool) return aMempool ? -1 : 1;
		if (aMempool && bMempool) return 0;
		return b.height - a.height;
	});
}

/**
 * Hydrates deltaSats/feeRate/time for a bounded set of history items. Fetches
 * each item's raw tx once, then resolves prevouts for every non-coinbase
 * vin ACROSS the whole batch (deduped, capped at ADDR_PREVOUT_CAP total).
 * If any of a tx's own inputs isn't resolved (fetch failure OR simply never
 * attempted past the cap), that row's deltaSats/feeRate are both null --
 * never a partial/misleading guess.
 */
async function hydrateRows(
	rpc: RpcCaller,
	address: string,
	scriptPubKeyHex: string,
	items: ElectrumHistoryItem[]
): Promise<AddressTxRow[]> {
	if (items.length === 0) return [];

	const settled = await Promise.allSettled(items.map((it) => getRawTransaction(rpc, it.tx_hash)));
	const txByTxid = new Map<string, RawTransaction>();
	items.forEach((it, i) => {
		const r = settled[i];
		if (r.status === 'fulfilled') txByTxid.set(it.tx_hash, r.value);
	});

	const refs: PrevoutRef[] = [];
	const seen = new Set<string>();
	for (const tx of txByTxid.values()) {
		if (isCoinbase(tx)) continue;
		for (const v of tx.vin) {
			if (!v.txid || v.vout === undefined) continue;
			const key = prevoutKey({ txid: v.txid, vout: v.vout });
			if (seen.has(key)) continue;
			seen.add(key);
			if (refs.length < ADDR_PREVOUT_CAP) refs.push({ txid: v.txid, vout: v.vout });
		}
	}
	const resolved = await resolvePrevouts(rpc, refs);

	return items.map((it): AddressTxRow => {
		const tx = txByTxid.get(it.tx_hash);
		if (!tx) return { txid: it.tx_hash, height: Math.max(it.height, 0), time: null, deltaSats: null, feeRate: null };

		const received = tx.vout
			.filter((o) => o.scriptPubKey.hex === scriptPubKeyHex)
			.reduce((s, o) => s + Math.round(o.value * 1e8), 0);

		if (isCoinbase(tx)) {
			return {
				txid: it.tx_hash,
				height: Math.max(it.height, 0),
				time: tx.blocktime ?? null,
				deltaSats: received, // a coinbase only ever adds -- honest, no input side to resolve
				feeRate: null // not applicable, never fabricated
			};
		}

		let sent = 0;
		let totalIn = 0;
		let allInputsResolved = true;
		for (const v of tx.vin) {
			if (!v.txid || v.vout === undefined) {
				allInputsResolved = false;
				break;
			}
			const r = resolved.get(prevoutKey({ txid: v.txid, vout: v.vout }));
			if (!r) {
				allInputsResolved = false;
				break;
			}
			totalIn += r.value;
			if (r.address === address) sent += r.value;
		}

		const totalOut = Math.round(tx.vout.reduce((s, o) => s + o.value, 0) * 1e8);
		return {
			txid: it.tx_hash,
			height: Math.max(it.height, 0),
			time: tx.blocktime ?? null,
			deltaSats: allInputsResolved ? received - sent : null,
			feeRate: allInputsResolved ? (totalIn - totalOut) / tx.vsize : null
		};
	});
}

/**
 * Domain cursor pagination (§1.6) -- Electrum's `get_history` has no native
 * pagination, so the FULL history is fetched once (cached 10s) and sliced
 * client-of-this-function-side. `cursor` is the last row's txid, never a
 * numeric offset. Throws if Electrum is unreachable (history is an
 * Electrum-only datum with no Core equivalent, §1.3) -- the page's own
 * degrade banner renders on that.
 */
export async function getAddressTxPage(
	node: AddressNode,
	address: string,
	cursor: string | null = null,
	limit = 25
): Promise<AddressTxPage> {
	const scripthash = addressToScriptHash(address);
	const scriptPubKeyHex = addressToScriptPubKey(address).toString('hex');
	const history = await getCachedHistory(node, scripthash);
	const sorted = sortHistoryNewestFirst(history);

	let startIdx = 0;
	if (cursor) {
		const idx = sorted.findIndex((h) => h.tx_hash === cursor);
		startIdx = idx === -1 ? sorted.length : idx + 1;
	}
	const pageItems = sorted.slice(startIdx, startIdx + limit);
	const withinCap = pageItems.filter((_, i) => startIdx + i < ADDR_DETAIL_CAP);
	const beyondCap = pageItems.filter((_, i) => startIdx + i >= ADDR_DETAIL_CAP);
	const detailTruncated = beyondCap.length > 0;

	const hydrated = await hydrateRows(node.coreRpc, address, scriptPubKeyHex, withinCap);
	const truncated: AddressTxRow[] = beyondCap.map((it) => ({
		txid: it.tx_hash,
		height: Math.max(it.height, 0),
		time: null,
		deltaSats: null,
		feeRate: null
	}));
	const rows = [...hydrated, ...truncated];

	// hasMore comes from the full history length (== AddressView.txCount) minus
	// rows loaded so far -- never from "did this page come back full" (§1.6
	// point 5's exact bug class both nodeview and cairn avoided).
	const loadedSoFar = startIdx + rows.length;
	const hasMore = loadedSoFar < sorted.length;

	return {
		rows,
		cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].txid : null,
		hasMore,
		detailTruncated
	};
}
