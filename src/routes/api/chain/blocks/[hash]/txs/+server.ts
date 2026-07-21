/**
 * GET /api/chain/blocks/:hash/txs?cursor=&limit= -- a block's tx list, one
 * page at a time (EXPLORER.md §1.4, §4.2). Never resolves more than one
 * page's worth of transactions per call.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getBlockTxPage } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');

	const cursorParam = event.url.searchParams.get('cursor');
	const limitParam = event.url.searchParams.get('limit');

	let cursor = 0;
	if (cursorParam) {
		const parsed = Number(cursorParam);
		if (!Number.isFinite(parsed) || parsed < 0) throw error(400, 'cursor must be a non-negative number');
		cursor = Math.floor(parsed);
	}
	let limit = DEFAULT_LIMIT;
	if (limitParam) {
		const parsed = Number(limitParam);
		if (!Number.isFinite(parsed) || parsed <= 0) throw error(400, 'limit must be a positive number');
		limit = Math.min(MAX_LIMIT, Math.floor(parsed));
	}

	const node = getNodeClient();
	const page = await getBlockTxPage(node, event.params.hash!, cursor, limit);
	return json(page);
}
