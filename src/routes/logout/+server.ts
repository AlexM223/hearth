import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, destroySession, SESSION_COOKIE } from '$lib/server/auth/index.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, url }) => {
	destroySession(cookies.get(SESSION_COOKIE));
	clearSessionCookie(cookies, url);
	throw redirect(303, '/login');
};
