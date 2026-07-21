/**
 * Explorer index loader (EXPLORER.md §1.8, §4.1). Reads the persisted SWR
 * snapshot SYNCHRONOUSLY -- no rail I/O in a page load, matching the wallet
 * module's own SWR discipline. A missing/wiped snapshot (first boot, or a
 * wiped cache table) renders the page's own calm empty state; the client
 * triggers `POST /api/chain/refresh` on mount to self-heal (T8 adds the
 * live SSE-triggered re-refresh on top of this).
 */
import { readExplorerSnapshot } from '$lib/server/chain/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const snapshot = readExplorerSnapshot();
	return {
		recentBlocks: snapshot?.data.recentBlocks ?? [],
		mempool: snapshot?.data.mempool ?? null,
		fees: snapshot?.data.fees ?? null,
		syncedAt: snapshot?.syncedAt ?? null
	};
};
