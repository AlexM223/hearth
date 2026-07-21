/**
 * In-process TTL/LRU caches (EXPLORER.md §1.8(b)) -- miss-safe, never
 * persisted, never itself the source of truth. A cold cache (process
 * restart) always degrades to a live rail fetch; there is no "missing cache
 * = broken page" path anywhere in `chain/`.
 */

interface Entry<V> {
	value: V;
	expiresAt: number | null;
}

/**
 * A capacity-bounded LRU, optionally TTL'd. `ttlMs: null` (the default) means
 * "immutable once fetched" -- entries only leave via LRU eviction, never a
 * timer (block detail / tx-id lists / confirmed tx detail, §1.8's "hashes
 * never get re-pointed by a reorg the way heights can" rows).
 */
export class LruCache<K, V> {
	private readonly map = new Map<K, Entry<V>>();

	constructor(
		private readonly capacity: number,
		private readonly ttlMs: number | null = null
	) {}

	get(key: K): V | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
			this.map.delete(key);
			return undefined;
		}
		// Refresh recency: delete + re-insert moves it to the Map's tail.
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	has(key: K): boolean {
		return this.get(key) !== undefined;
	}

	set(key: K, value: V): void {
		this.map.delete(key);
		this.map.set(key, { value, expiresAt: this.ttlMs !== null ? Date.now() + this.ttlMs : null });
		if (this.map.size > this.capacity) {
			const oldestKey = this.map.keys().next().value as K | undefined;
			if (oldestKey !== undefined) this.map.delete(oldestKey);
		}
	}

	delete(key: K): void {
		this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

// ── Named instances per the §1.8(b) table ──────────────────────────────────
import type { AddressTxRow, BlockDetail, FeeRecommendation, MempoolSummary, PoolAttribution, TxDetail } from './types.js';
import type { ElectrumHistoryItem } from '../node/electrum/client.js';

/** `pool` is never cached (it's viewer-scoped via `isYou`, blocks.ts/tx.ts §2)
 *  -- callers attach it fresh per call on top of the cached row. */
export type CachedBlockDetail = Omit<BlockDetail, 'pool'>;

/** Immutable once fetched -- hashes never get "re-pointed" by a reorg. */
export const blockDetailCache = new LruCache<string, CachedBlockDetail>(500);
/** The block's ordered txid[] (verbosity-1 getblock), immutable per hash. */
export const blockTxIdsCache = new LruCache<string, string[]>(200);
/** Only ever populated for a tx with `confirmations >= 1` -- an unconfirmed
 *  tx's CPFP/RBF context changes every block, so callers must not cache it
 *  (blocks.ts/tx.ts enforce this at the call site, not here). */
export const txDetailCache = new LruCache<string, TxDetail>(2000);
/** Backs the address-history pagination cursor slicing (§1.6). */
export const addressHistoryCache = new LruCache<string, ElectrumHistoryItem[]>(500, 10_000);

const GLOBAL_KEY = 'global';
export const mempoolSummaryCache = new LruCache<typeof GLOBAL_KEY, MempoolSummary>(1, 8_000);
export const feeHistogramCache = new LruCache<typeof GLOBAL_KEY, [number, number][]>(1, 8_000);
export const feeRecommendationCache = new LruCache<typeof GLOBAL_KEY, FeeRecommendation>(1, 30_000);
export const poolAttributionCache = new LruCache<string, PoolAttribution | null>(500, 30_000);
/** Full history per scripthash, backing getAddressTxPage's cursor slicing (§1.6). */
export const addressPageRowsCache = new LruCache<string, AddressTxRow[]>(500, 10_000);

export { GLOBAL_KEY };

/** Test-only: reset every named cache (avoids cross-test bleed). */
export function clearAllCaches(): void {
	blockDetailCache.clear();
	blockTxIdsCache.clear();
	txDetailCache.clear();
	addressHistoryCache.clear();
	mempoolSummaryCache.clear();
	feeHistogramCache.clear();
	feeRecommendationCache.clear();
	poolAttributionCache.clear();
	addressPageRowsCache.clear();
}
