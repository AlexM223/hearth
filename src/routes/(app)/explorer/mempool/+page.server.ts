/**
 * Advanced: raw mempool histogram + summary (EXPLORER.md §4.1). The full
 * "projected blocks" breakdown mempool.space-style is out of M4's scope --
 * the raw histogram + summary numbers are the Advanced view this milestone
 * ships; a richer projection is a natural M5+ follow-up once the mining
 * dashboard's own chart patterns exist to reuse.
 */
import { getMempoolSummary, getFeeHistogram } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const node = getNodeClient();
	const [summary, histogram] = await Promise.all([getMempoolSummary(node), getFeeHistogram(node)]);
	return { summary, histogram };
};
