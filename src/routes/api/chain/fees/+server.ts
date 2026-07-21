/**
 * GET /api/chain/fees -- getFeeRecommendation (EXPLORER.md §1.3/§3.1, §4.2).
 * Throws only on a total rail outage (neither Electrum nor Core priced ANY
 * tier) -- never a fabricated glanceable number; the route surfaces that as
 * a 503 so the client renders its own calm degrade state.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getFeeRecommendation } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'guest');
	const node = getNodeClient();
	try {
		const rec = await getFeeRecommendation(node);
		return json(rec);
	} catch {
		throw error(503, 'fee estimate unavailable -- node unreachable');
	}
}
