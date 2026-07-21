/**
 * GET /api/chain/address/:address?cursor=&limit= -- address view + a page
 * of its history (EXPLORER.md §1.6, §4.2). The view and the history page
 * degrade independently: if history is unavailable (Electrum down, no Core
 * equivalent) but the view itself resolved (even via the scantxoutset
 * floor), the response still carries the view with an empty page rather
 * than failing the whole request.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getAddressView, getAddressTxPage, isDecodableAddress } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');
	const address = event.params.address!;
	if (!isDecodableAddress(address)) throw error(400, 'not a valid address');

	const cursor = event.url.searchParams.get('cursor');
	const limitParam = event.url.searchParams.get('limit');
	let limit = DEFAULT_LIMIT;
	if (limitParam) {
		const parsed = Number(limitParam);
		if (!Number.isFinite(parsed) || parsed <= 0) throw error(400, 'limit must be a positive number');
		limit = Math.min(MAX_LIMIT, Math.floor(parsed));
	}

	const node = getNodeClient();
	const [viewResult, pageResult] = await Promise.allSettled([
		getAddressView(node, address),
		getAddressTxPage(node, address, cursor, limit)
	]);

	if (viewResult.status === 'rejected') {
		throw error(503, 'node unreachable -- try again shortly');
	}
	const page =
		pageResult.status === 'fulfilled'
			? pageResult.value
			: { rows: [], cursor: null, hasMore: false, detailTruncated: false };

	return json({ view: viewResult.value, page });
}
