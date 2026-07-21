/**
 * GET/POST /api/me/prefs -- self, own theme preference (COME-ABOARD.md §6.2).
 * Notification-channel prefs land with the M6 notify module; this seam is
 * real (persisted, round-trips) rather than a stub.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole, getOwnPrefs, setOwnTheme } from '$lib/server/auth/index.js';

export function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'authed');
	return json(getOwnPrefs(user.id));
}

export async function POST(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'authed');
	let body: { theme?: string };
	try {
		body = (await event.request.json()) as { theme?: string };
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (body.theme !== 'system' && body.theme !== 'dark' && body.theme !== 'light') {
		throw error(400, 'theme must be system, dark, or light');
	}
	setOwnTheme(user.id, body.theme);
	return json({ ok: true });
}
