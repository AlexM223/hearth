import { fail, redirect } from '@sveltejs/kit';
import {
	AuthError,
	completeForcedCredentialReset,
	createSession,
	setSessionCookie
} from '$lib/server/auth/index.js';
import type { Actions, PageServerLoad } from './$types';

/** Only reachable by an authenticated user mid forced-reset -- hooks.server.ts's
 *  guard already redirects anyone else away from here (or away from here once done). */
export const load: PageServerLoad = ({ locals }) => {
	return { username: locals.user?.username ?? '' };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const username = String(data.get('username') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const confirmPassword = String(data.get('confirmPassword') ?? '');

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match.', username });
		}

		try {
			await completeForcedCredentialReset(locals.user.id, { username, password });
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message, username });
			throw e;
		}

		// completeForcedCredentialReset revoked every session for this user
		// (the bootstrap password was visible in the platform's install UI) --
		// mint a fresh one under the new credentials.
		const { token, expiresAt } = createSession(locals.user.id);
		setSessionCookie(cookies, token, expiresAt, url);

		throw redirect(303, '/');
	}
};
