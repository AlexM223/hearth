/**
 * The self-calibrating SPV difficulty floor (WATCHTOWER.md §1.3, cairn-8kbw).
 * Hearth reads ONE Electrum server, so a header's own-`bits` PoW check alone
 * only proves internal self-consistency -- a hostile/compromised server can
 * mine a trivially-easy header in milliseconds. This rolling cache of the
 * hardest targets actually observed on the live header stream makes forging
 * a header that clears the floor cost real work, without any bundled
 * hardcoded checkpoint: the live stream IS the moving anchor, so the floor
 * tightens automatically as real difficulty rises.
 *
 * A factory (not a module singleton) -- each Watchtower instance (and each
 * test) owns its own independent cache; `wallet/index.ts`'s parseBlockHeader
 * + meetsTarget are reused for header parsing/PoW, never re-implemented here
 * (DECISIONS.md §4.9 invariant 3, enforced by notify/spvSingleSource.spec.ts).
 */
import { parseBlockHeader, bitsToTarget, meetsTarget } from '$lib/server/wallet/index.js';

export const TIP_CACHE_SIZE = 144;
export const DIFFICULTY_FLOOR_FACTOR = 4n;

export interface CachedHeader {
	hash: string; // display-order hex
	target: bigint;
}

export interface DifficultyFloor {
	/** Validate + fold a header into the cache. Returns true iff accepted.
	 *  Rejects: unparseable, PoW-self-inconsistent, or implausibly weaker than
	 *  DIFFICULTY_FLOOR_FACTOR times the hardest target already held (a
	 *  hostile server priming the cache). Safe to call with ANY header --
	 *  never trusts input blindly. */
	acceptHeader(height: number, headerHex: string): boolean;
	/** The hardest (numerically SMALLEST) target currently cached; 0n when
	 *  empty. Named to match WATCHTOWER.md §1.3's `maxCachedTarget()` --
	 *  "max" refers to max DIFFICULTY, which is min target. */
	maxTarget(): bigint;
	/** The cached entry for a height, if any. */
	cachedHeader(height: number): CachedHeader | undefined;
	/** The max height ever accepted (the moving tip anchor). */
	tipHeight(): number;
	/** Current cache population (0 = cold). */
	size(): number;
	/** Clear everything -- an Electrum client swap means old-server tips are
	 *  not a valid floor for a new server (WATCHTOWER.md §1.2). */
	reset(): void;
}

export function createDifficultyFloor(): DifficultyFloor {
	const cache = new Map<number, CachedHeader>();
	let tip = 0;

	/** The SMALLEST (= hardest / highest-difficulty) target currently cached. */
	function maxTarget(): bigint {
		let hardest = 0n;
		for (const { target } of cache.values()) {
			if (hardest === 0n || target < hardest) hardest = target;
		}
		return hardest;
	}

	function pruneToCapacity(): void {
		if (cache.size <= TIP_CACHE_SIZE) return;
		const heights = [...cache.keys()].sort((a, b) => a - b);
		const excess = heights.length - TIP_CACHE_SIZE;
		for (let i = 0; i < excess; i++) cache.delete(heights[i]);
	}

	function acceptHeader(height: number, headerHex: string): boolean {
		const parsed = parseBlockHeader(headerHex);
		if (!parsed) return false;
		if (!meetsTarget(headerHex)) return false;
		const target = bitsToTarget(parsed.bits);
		const priorMax = maxTarget();
		if (priorMax > 0n && target > priorMax * DIFFICULTY_FLOOR_FACTOR) return false;
		cache.set(height, { hash: parsed.hash, target });
		if (height > tip) tip = height;
		pruneToCapacity();
		return true;
	}

	return {
		acceptHeader,
		maxTarget,
		cachedHeader: (height) => cache.get(height),
		tipHeight: () => tip,
		size: () => cache.size,
		reset: () => {
			cache.clear();
			tip = 0;
		}
	};
}
