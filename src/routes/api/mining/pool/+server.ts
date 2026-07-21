/**
 * GET /api/mining/pool -- getPublicPoolView (MINING-ENGINE.md §6.1). Any
 * signed-in role may see the shared pool view (hashrate, leaderboard, trophy
 * wall) -- no settings/per-connection-difficulty/fatal-errors here (owner-only).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getPublicPoolView } from '$lib/server/mining/readModels.js';

export async function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'guest');
	try {
		const view = await getPublicPoolView(user.id);
		return json(view);
	} catch {
		throw error(503, 'pool view unavailable');
	}
}
