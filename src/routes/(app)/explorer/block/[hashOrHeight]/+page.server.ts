/**
 * Block detail loader (EXPLORER.md §1.4, §3.3). Never a silent 404 for an
 * unresolvable block -- richness:'none' renders the page's own calm banner.
 */
import { getBlockDetail, getBlockTxPage } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import type { PageServerLoad } from './$types';

const TX_PAGE_SIZE = 25;

export const load: PageServerLoad = async ({ locals, params }) => {
	const node = getNodeClient();
	const viewerUserId = locals.user?.id ?? null;
	const detail = await getBlockDetail(node, params.hashOrHeight, viewerUserId);

	const txPage =
		detail.richness !== 'none'
			? await getBlockTxPage(node, detail.hash, 0, TX_PAGE_SIZE)
			: { txids: [], rows: [], cursor: 0, hasMore: false };

	return { detail, txPage };
};
