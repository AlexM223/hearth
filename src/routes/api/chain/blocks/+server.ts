/**
 * GET /api/chain/blocks?before=&limit= -- paginated recent-blocks list
 * (EXPLORER.md §4.2). No `before` -> the newest `limit` blocks; `before`
 * (a height) -> the `limit` blocks strictly before it (the "see all" full
 * list's own pagination).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { listRecentBlocks, listBlocksBefore } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export async function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'guest');
	const beforeParam = event.url.searchParams.get('before');
	const limitParam = event.url.searchParams.get('limit');

	let limit = DEFAULT_LIMIT;
	if (limitParam) {
		const parsed = Number(limitParam);
		if (!Number.isFinite(parsed) || parsed <= 0) throw error(400, 'limit must be a positive number');
		limit = Math.min(MAX_LIMIT, Math.floor(parsed));
	}

	const node = getNodeClient();
	const viewerUserId = user.id;

	if (beforeParam) {
		const before = Number(beforeParam);
		if (!Number.isFinite(before) || before < 0) throw error(400, 'before must be a non-negative height');
		const blocks = await listBlocksBefore(node, before, limit, viewerUserId);
		return json({ blocks });
	}

	const blocks = await listRecentBlocks(node, limit, viewerUserId);
	return json({ blocks });
}
