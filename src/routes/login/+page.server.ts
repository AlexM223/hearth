import { fail, redirect } from '@sveltejs/kit';
import { AuthError, createSession, loginWithPassword, setSessionCookie } from '$lib/server/auth/index.js';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const username = String(data.get('username') ?? '').trim();
		const password = String(data.get('password') ?? '');

		if (!username || !password) {
			return fail(400, { error: 'Enter your username and password.', username });
		}

		let userId: number;
		try {
			const user = await loginWithPassword(username, password);
			userId = user.id;
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message, username });
			throw e;
		}

		const { token, expiresAt } = createSession(userId);
		setSessionCookie(cookies, token, expiresAt, url);

		throw redirect(303, '/');
	}
};
