/**
 * classifySearch() -- the top-nav global search resolver (EXPLORER.md §1.7,
 * §3.6). Pure/synchronous shape checks first, then at most one network
 * round-trip, wall-clock budgeted so a slow/misconfigured backend can never
 * hang first paint. `chain/` never opens its own sockets -- probes go
 * through the same NodeClient rails every other chain/*.ts file uses, via
 * the narrow `SearchNode` surface below (house convention, wallet/sync.ts's
 * `SyncNode`).
 */
import { isDecodableAddress } from './address.js';
import type { SearchResult } from './types.js';
import type { RpcCaller } from '../node/core/rpc.js';

export const HEIGHT_RE = /^\d{1,9}$/;
export const HEX64_RE = /^[0-9a-fA-F]{64}$/;

const PROBE_BUDGET_MS = 3000;

export type ProbeResult = 'found' | 'not-found' | 'error';

export interface SearchNode {
	coreRpc: RpcCaller;
}

export type { SearchResult };

/** Core's "not found" RPC code (-5) vs anything else (transport/timeout/auth
 *  -- a genuine rail problem, not a negative answer). */
function isNotFoundError(err: unknown): boolean {
	const code = (err as { rpcCode?: number } | null)?.rpcCode;
	return code === -5;
}

/** `getrawtransaction(txid, false)` -- a cheap existence probe (hex only, no
 *  full decode). txindex=1 is the dev/Umbrel default (DECISIONS.md §4.4). */
export async function probeTxExists(node: SearchNode, txid: string): Promise<ProbeResult> {
	try {
		await node.coreRpc.call<string>('getrawtransaction', [txid, false]);
		return 'found';
	} catch (err) {
		return isNotFoundError(err) ? 'not-found' : 'error';
	}
}

/** `getblockheader(hash)` -- a cheap existence probe (header only). */
export async function probeBlockExists(node: SearchNode, hash: string): Promise<ProbeResult> {
	try {
		await node.coreRpc.call<unknown>('getblockheader', [hash]);
		return 'found';
	} catch (err) {
		return isNotFoundError(err) ? 'not-found' : 'error';
	}
}

/** Races each promise against a shared wall-clock budget; a timed-out entry
 *  resolves to `undefined` rather than hanging classifySearch. Never rejects
 *  -- a rejected input promise is treated the same as a timeout. */
export async function withBudget<T>(ms: number, promises: Promise<T>[]): Promise<(T | undefined)[]> {
	return Promise.all(
		promises.map(
			(p) =>
				new Promise<T | undefined>((resolve) => {
					const timer = setTimeout(() => resolve(undefined), ms);
					timer.unref?.();
					p.then(
						(v) => {
							clearTimeout(timer);
							resolve(v);
						},
						() => {
							clearTimeout(timer);
							resolve(undefined);
						}
					);
				})
		)
	);
}

/**
 * Detection order (EXPLORER.md §1.7): height -> leading-zero block hash
 * heuristic (skip the lookup entirely, the overwhelmingly common case for a
 * real PoW block hash) -> genuinely ambiguous 64-hex probed on both rails
 * concurrently -> address (ECC-free decode) -> unknown.
 */
export async function classifySearch(q: string, node: SearchNode): Promise<SearchResult> {
	const v = q.trim();

	if (HEIGHT_RE.test(v)) {
		// Optimistic: the block page itself surfaces "height beyond tip" / "node
		// still syncing" honestly -- no lookup needed here.
		return { type: 'block', value: v };
	}

	if (HEX64_RE.test(v)) {
		if (/^0{8,}/.test(v)) return { type: 'block', value: v };

		const [txProbe, blockProbe] = await withBudget(PROBE_BUDGET_MS, [
			probeTxExists(node, v),
			probeBlockExists(node, v)
		]);

		// A genuine rail error (or a probe timeout, folded into the same
		// "undefined" bucket by withBudget) prefers `tx` -- nodeview's choice --
		// so the tx page's own honest richness:'none' empty state renders
		// rather than a blanket "couldn't search" dead end.
		if (txProbe === 'error' || txProbe === undefined) return { type: 'tx', value: v };
		if (txProbe === 'found') return { type: 'tx', value: v };
		if (blockProbe === 'found') return { type: 'block', value: v };
		return { type: 'unknown', value: v };
	}

	if (isDecodableAddress(v)) return { type: 'address', value: v };
	return { type: 'unknown', value: v };
}
