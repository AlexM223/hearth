/**
 * Tx detail loader (EXPLORER.md §1.5, §3.4). getTxDetail throws only when
 * the tx can't be resolved on any rail -- a genuine "not found" (Core -5)
 * renders 404; anything else renders the page's own calm degraded state
 * rather than a crash.
 */
import { error } from '@sveltejs/kit';
import { getTxDetail } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const node = getNodeClient();
	const viewerUserId = locals.user?.id ?? null;
	try {
		const detail = await getTxDetail(node, params.txid, viewerUserId);
		return { detail, unavailable: false as const };
	} catch (e) {
		const rpcCode = (e as { rpcCode?: number } | null)?.rpcCode;
		if (rpcCode === -5) throw error(404, 'transaction not found');
		// A down rail, not a genuine 404 -- render the page's own calm
		// richness:'none'-equivalent empty state rather than a crash.
		return { detail: null, unavailable: true as const };
	}
};
