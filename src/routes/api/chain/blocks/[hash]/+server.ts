/**
 * GET /api/chain/blocks/:hashOrHeight -- block detail (EXPLORER.md §1.4,
 * §4.2). Accepts either a block hash or a height (blocks.ts's own
 * isHeightInput branch). Never a silent 404 -- a totally-unresolvable block
 * still comes back 200 with `richness: 'none'` (EXPLORER.md §1.3); the page
 * renders its own calm degrade banner on that.
 */
import { json, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getBlockDetail } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'guest');
	const node = getNodeClient();
	const detail = await getBlockDetail(node, event.params.hash!, user.id);
	return json(detail);
}
