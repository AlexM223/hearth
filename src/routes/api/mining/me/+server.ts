/**
 * GET /api/mining/me -- getUserMiningView (MINING-ENGINE.md §6.1), Member+
 * only (a Guest has no wallet to mine to). Strictly scoped to the caller's
 * own workers/prefs/blocks (readModels.spec.ts's security regression test).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getUserMiningView } from '$lib/server/mining/readModels.js';

export async function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'member');
	try {
		const view = await getUserMiningView(user.id);
		return json(view);
	} catch {
		throw error(503, 'mining view unavailable');
	}
}
