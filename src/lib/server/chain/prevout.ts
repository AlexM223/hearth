/**
 * Shared prevout resolution (EXPLORER.md §1.5 step 2, reused by blocks.ts's
 * list-view fee sample §1.4 and tx.ts's detail fee/vin enrichment). Core's
 * `getrawtransaction(txid, 2)` leaves prevout resolution to the caller --
 * this walks each referenced PARENT tx (requires txindex=1) and reads
 * `vout[n]` for its address/value, deduping repeat parent-tx fetches within
 * one call. NOT `gettxout` (nodeview's finding: it only sees the CURRENT
 * UTXO set and would fail for the common already-spent case).
 */
import { getRawTransaction, type RpcCaller } from '../node/index.js';

export interface PrevoutRef {
	txid: string;
	vout: number;
}

export interface ResolvedPrevout {
	address: string | null;
	value: number; // sats
}

/**
 * Resolves each `(txid, vout)` ref to its address/value, deduping repeated
 * parent txids. A parent tx that fails to fetch (or a vout index the parent
 * doesn't have) is simply ABSENT from the returned map -- never thrown --
 * callers treat a missing key as "unresolved" per the cardinal null rule.
 */
export async function resolvePrevouts(
	rpc: RpcCaller,
	refs: PrevoutRef[]
): Promise<Map<string, ResolvedPrevout>> {
	const distinctTxids = [...new Set(refs.map((r) => r.txid))];
	const fetched = await Promise.allSettled(distinctTxids.map((txid) => getRawTransaction(rpc, txid)));

	const out = new Map<string, ResolvedPrevout>();
	for (const ref of refs) {
		const idx = distinctTxids.indexOf(ref.txid);
		const settled = fetched[idx];
		if (!settled || settled.status !== 'fulfilled') continue;
		const vout = settled.value.vout[ref.vout];
		if (!vout) continue;
		out.set(prevoutKey(ref), {
			address: vout.scriptPubKey.address ?? null,
			value: Math.round(vout.value * 1e8)
		});
	}
	return out;
}

export function prevoutKey(ref: PrevoutRef): string {
	return `${ref.txid}:${ref.vout}`;
}
