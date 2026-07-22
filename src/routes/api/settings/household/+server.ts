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

/** A household name is shown as a greeting on every page (§3.6) -- long
 *  enough for any real name, short enough that a runaway/garbage value can't
 *  bloat storage or blow out the greeting layout. */
const MAX_HOUSEHOLD_NAME_LENGTH = 120;

export async function POST(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	let body: Body;
	try {
		body = (await event.request.json()) as Body;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.householdName === 'string' && body.householdName.trim()) {
		if (body.householdName.length > MAX_HOUSEHOLD_NAME_LENGTH) {
			throw error(400, `household name cannot exceed ${MAX_HOUSEHOLD_NAME_LENGTH} characters`);
		}
		setHouseholdName(body.householdName);
	}
	if (typeof body.guestSeesHouseholdBalance === 'boolean') {
		setGuestSeesHouseholdBalance(body.guestSeesHouseholdBalance);
	}
	return json({ ok: true });
}
