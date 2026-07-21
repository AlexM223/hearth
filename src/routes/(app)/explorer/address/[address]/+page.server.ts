/**
 * Address detail loader (EXPLORER.md §1.6, §3.5). Balance and history
 * degrade independently -- a history-rail failure never blanks an already
 * -resolved balance.
 */
import { error } from '@sveltejs/kit';
import { getAddressView, getAddressTxPage, isDecodableAddress } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 25;

export const load: PageServerLoad = async ({ params }) => {
	if (!isDecodableAddress(params.address)) throw error(400, 'not a valid address');

	const node = getNodeClient();
	const [viewResult, pageResult] = await Promise.allSettled([
		getAddressView(node, params.address),
		getAddressTxPage(node, params.address, null, PAGE_SIZE)
	]);

	if (viewResult.status === 'rejected') {
		return { view: null, page: null, address: params.address };
	}
	const page =
		pageResult.status === 'fulfilled'
			? pageResult.value
			: { rows: [], cursor: null, hasMore: false, detailTruncated: false };

	return { view: viewResult.value, page, address: params.address };
};
