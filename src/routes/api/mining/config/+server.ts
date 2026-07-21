/**
 * GET /api/mining/config -- getAdminMiningView (engine status, pool
 * aggregate, per-miner breakdown, and the settings the Owner form edits).
 * Owner-only (DECISIONS.md §4.3): settings, per-connection difficulty, and
 * fatal errors are genuinely sensitive admin material.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getAdminMiningView } from '$lib/server/mining/readModels.js';

export async function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	try {
		const view = await getAdminMiningView();
		return json(view);
	} catch {
		throw error(503, 'admin mining view unavailable');
	}
}
