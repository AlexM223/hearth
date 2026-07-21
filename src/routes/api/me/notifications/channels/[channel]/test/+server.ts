/**
 * POST /api/me/notifications/channels/:channel/test -- the Settings/`/me`
 * "Send test" button (WATCHTOWER.md §2.6, T7). Calls the channel plugin's
 * OWN `test(userId)`, which sends a canned payload through the IDENTICAL
 * `send` path (same SSRF gate, same signing, same transport) -- a green
 * result proves the real thing works, and the verbatim `ChannelSendResult`
 * (including `.error`, e.g. Telegram's "message your bot first" 403) is
 * returned so the UI can surface it for debugging. Self-scoped: any
 * authenticated role tests only their OWN configured channel (policy table:
 * `/api/me/**` is `authed`, matching COME-ABOARD.md §3.2's self-scope rule).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { CHANNELS } from '$lib/server/notify/channels/index.js';
import { EXTERNAL_NOTIFICATION_CHANNELS } from '$lib/server/notify/types.js';
import type { ExternalChannelId } from '$lib/server/notify/config/channelConfig.js';

function isExternalChannel(value: string): value is ExternalChannelId {
	return (EXTERNAL_NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export async function POST(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'authed');
	const channel = event.params.channel ?? '';
	if (!isExternalChannel(channel)) throw error(400, 'unknown notification channel');

	const result = await CHANNELS[channel].test(user.id);
	return json(result);
}
