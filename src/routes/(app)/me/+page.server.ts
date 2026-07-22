/**
 * /me -- self profile & prefs (COME-ABOARD.md §3.2's carve-out, §6.3). Every
 * role reaches this page; it's where a Member/Guest changes their own
 * password since Settings is Owner-only.
 */
import { fail } from '@sveltejs/kit';
import { updateOwnProfile, getOwnPrefs, setOwnTheme, setSessionCookie, AuthError } from '$lib/server/auth/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = locals.user!;
	return {
		prefs: getOwnPrefs(user.id)
	};
};

export const actions: Actions = {
	updateProfile: async ({ request, locals, cookies, url }) => {
		const data = await request.formData();
		const displayName = String(data.get('displayName') ?? '');
		const currentPassword = String(data.get('currentPassword') ?? '') || undefined;
		const newPassword = String(data.get('newPassword') ?? '') || undefined;
		const confirmPassword = String(data.get('confirmPassword') ?? '') || undefined;

		if (newPassword && newPassword !== confirmPassword) {
			return fail(400, { error: 'New passwords do not match.' });
		}

		try {
			const { newSession } = await updateOwnProfile(locals.user!.id, {
				displayName,
				currentPassword,
				newPassword
			});
			// A password change just destroyed every session for this user,
			// including the one this request came in on -- reissue the cookie
			// against the fresh session so the caller stays logged in.
			if (newSession) {
				setSessionCookie(cookies, newSession.token, newSession.expiresAt, url);
			}
			return { saved: true };
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
	},

	setTheme: async ({ request, locals }) => {
		const form = await request.formData();
		const theme = String(form.get('theme') ?? 'system');
		if (theme === 'system' || theme === 'dark' || theme === 'light') {
			setOwnTheme(locals.user!.id, theme);
		}
		return {};
	}
};
