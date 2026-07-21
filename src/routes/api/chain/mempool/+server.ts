/**
 * GET /api/chain/mempool -- mempool summary + fee histogram (EXPLORER.md
 * §1.3, §4.2; the Advanced raw-mempool view's data source). Both datums
 * degrade independently and NEVER throw (mempool.ts's own try/catch always
 * resolves to a richness:'none' shape on failure) -- this route never 503s.
 */
import { json, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getMempoolSummary, getFeeHistogram } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');
	const node = getNodeClient();
	const [summary, histogram] = await Promise.all([getMempoolSummary(node), getFeeHistogram(node)]);
	return json({ summary, histogram });
}
