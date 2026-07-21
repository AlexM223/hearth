/**
 * GET /api/chain/search?q= -- classifySearch (EXPLORER.md §1.7, §4.2). Guest
 * -readable: the shared instrument's global search reaches every role.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { classifySearch } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');
	const q = event.url.searchParams.get('q');
	if (!q || !q.trim()) throw error(400, 'q is required');

	const node = getNodeClient();
	const result = await classifySearch(q, node);
	return json(result);
}
