/**
 * POST /api/settings/household -- Owner sets the household/captain name and
 * the Guest household-balance opt-in (COME-ABOARD.md §3.6, §6.2).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole, setHouseholdName, setGuestSeesHouseholdBalance } from '$lib/server/auth/index.js';

interface Body {
	householdName?: string;
	guestSeesHouseholdBalance?: boolean;
}

export async function POST(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	let body: Body;
	try {
		body = (await event.request.json()) as Body;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.householdName === 'string' && body.householdName.trim()) {
		setHouseholdName(body.householdName);
	}
	if (typeof body.guestSeesHouseholdBalance === 'boolean') {
		setGuestSeesHouseholdBalance(body.guestSeesHouseholdBalance);
	}
	return json({ ok: true });
}
