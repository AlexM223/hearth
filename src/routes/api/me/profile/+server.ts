/**
 * POST /api/me/profile -- self-service display name + password change
 * (COME-ABOARD.md §3.2's carve-out, §6.2). Gated `authed`, self-scoped:
 * always operates on the CALLER's own row, never a param -- there is no
 * :id in this route, by design, so it's structurally impossible to edit
 * anyone else's profile from here.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole, updateOwnProfile, AuthError } from '$lib/server/auth/index.js';

interface ProfileBody {
	displayName?: string | null;
	currentPassword?: string;
	newPassword?: string;
}

export async function POST(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'authed');
	let body: ProfileBody;
	try {
		body = (await event.request.json()) as ProfileBody;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	try {
		await updateOwnProfile(user.id, {
			displayName: body.displayName,
			currentPassword: body.currentPassword,
			newPassword: body.newPassword
		});
		return json({ ok: true });
	} catch (e) {
		if (e instanceof AuthError) throw error(400, e.message);
		throw e;
	}
}
