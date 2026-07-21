/**
 * POST /api/chain/refresh -- triggers refreshExplorerSnapshot (throttled/
 * single-flight, EXPLORER.md §1.8, §4.2). Any role may nudge it since it
 * only re-reads public chain data -- called on client mount and on every
 * 'block' SSE event (T8).
 */
import { json, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { refreshExplorerSnapshot } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function POST(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');
	const node = getNodeClient();
	const snapshot = await refreshExplorerSnapshot(node);
	return json({ syncedAt: snapshot?.syncedAt ?? null });
}
