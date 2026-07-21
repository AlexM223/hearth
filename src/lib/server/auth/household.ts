/**
 * Household identity for the captain greeting (COME-ABOARD.md §1.1, §2.1).
 * Reuses the `meta` kv table -- no new table. `household.name` is an
 * Owner-editable, intentionally public-facing label (COME-ABOARD.md §2.3:
 * safe to preview pre-auth); it falls back to the first Owner's
 * display_name/username when unset so a fresh instance always has a name to
 * greet with.
 */
import { getDb } from '../db/index.js';
import { getMeta, setMeta } from '../db/meta.js';

const HOUSEHOLD_NAME_KEY = 'household.name';

/** The Owner-chosen household/captain name shown on the pre-auth landing and
 *  Home greeting. Falls back to the first Owner's display_name, then username. */
export function householdGreetingName(): string {
	const explicit = getMeta(HOUSEHOLD_NAME_KEY);
	if (explicit && explicit.trim().length > 0) return explicit.trim();

	const owner = getDb()
		.prepare(
			`SELECT username, display_name FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1`
		)
		.get() as { username: string; display_name: string | null } | undefined;
	if (!owner) return 'your host';
	return owner.display_name?.trim() || owner.username;
}

export function setHouseholdName(name: string): void {
	setMeta(HOUSEHOLD_NAME_KEY, name.trim());
}

export function getHouseholdNameSetting(): string | null {
	return getMeta(HOUSEHOLD_NAME_KEY);
}

// ------------------------------------------- guest household-balance opt-in

const GUEST_SEES_BALANCE_KEY = 'guest.seeHouseholdBalance';

/** Default OFF (COME-ABOARD §3.6): a Guest seeing the household's total
 *  holdings is a materially stronger grant than "dashboard stats" -- least
 *  privilege means the Owner opts IN, deliberately. */
export function guestSeesHouseholdBalance(): boolean {
	return getMeta(GUEST_SEES_BALANCE_KEY) === '1';
}

export function setGuestSeesHouseholdBalance(enabled: boolean): void {
	setMeta(GUEST_SEES_BALANCE_KEY, enabled ? '1' : '0');
}

// ------------------------------------------------------ welcome ribbon flag

function welcomedKey(userId: number): string {
	return `welcomed.${userId}`;
}

/** Whether this user's one-time Home welcome ribbon (COME-ABOARD §2.5) has
 *  already been shown + dismissed. */
export function hasBeenWelcomed(userId: number): boolean {
	return getMeta(welcomedKey(userId)) === '1';
}

export function markWelcomed(userId: number): void {
	setMeta(welcomedKey(userId), '1');
}
