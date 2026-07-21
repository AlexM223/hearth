/**
 * The captain-identified landing (COME-ABOARD.md §2). PUBLIC route, rendered
 * OUTSIDE the (app) shell (no top-nav, no member chrome -- the visitor isn't
 * a member yet).
 *
 * `load` is the security boundary (§2.3, STRICT): for an open invite it
 * returns EXACTLY {state, captain, role, grants} and imports NOTHING from
 * wallet/chain/member/mining -- no balance, no address, no node health, no
 * member list is ever reachable pre-auth, even accidentally. `grants` is a
 * compile-time constant (ROLE_GRANTS below), never derived from live data.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { lookupActiveInvite, type InviteRole } from '$lib/server/auth/invites.js';
import { householdGreetingName } from '$lib/server/auth/household.js';
import { acceptInvite, AcceptInviteError } from '$lib/server/auth/accept.js';
import { setSessionCookie } from '$lib/server/auth/session.js';

/** Static, human-readable capability list per role (§2.2, §2.3) -- a
 *  compile-time constant, never a live read. */
const ROLE_GRANTS: Record<InviteRole, string[]> = {
	member: [
		'Hold your own wallet — you keep the keys',
		'Get told the moment your money moves',
		'See the shared explorer & node health'
	],
	guest: [
		'Watch the shared explorer & node health',
		'See the mining pool, if it’s on',
		'No wallet, no spending — just the view'
	]
};

export const load: PageServerLoad = ({ params }) => {
	const invite = lookupActiveInvite(params.code);
	if (!invite) return { state: 'invalid' as const };
	return {
		state: 'open' as const,
		captain: householdGreetingName(),
		role: invite.role,
		grants: ROLE_GRANTS[invite.role]
	};
};

export const actions: Actions = {
	default: async ({ request, params, cookies, url }) => {
		const data = await request.formData();
		const username = String(data.get('username') ?? '');
		const password = String(data.get('password') ?? '');
		const confirmPassword = String(data.get('confirmPassword') ?? '');
		const displayNameRaw = String(data.get('displayName') ?? '').trim();

		try {
			const accepted = await acceptInvite({
				code: params.code,
				username,
				password,
				confirmPassword,
				displayName: displayNameRaw || null
			});
			setSessionCookie(cookies, accepted.sessionToken, accepted.sessionExpiresAt, url);
		} catch (e) {
			if (e instanceof AcceptInviteError) {
				// invite_invalid / invite_race_lost: the form action's automatic
				// reload re-runs `load`, which will naturally show the dead-end
				// state now that the invite is genuinely inactive -- no field echo
				// needed since there's nothing left to retry with THIS code.
				// invalid_username / weak_password / password_mismatch /
				// username_taken: still an OPEN invite -- echo the non-secret
				// fields so the invitee doesn't have to retype them.
				return fail(400, {
					error: e.message,
					errorCode: e.code,
					username,
					displayName: displayNameRaw
				});
			}
			throw e;
		}
		// Role-specific first-30s choreography (welcome ribbon, CTA) lives on
		// Home itself (T8) -- both roles land here; Home tells fresh from
		// returning via the per-user welcomed flag.
		throw redirect(303, '/');
	}
};
