/**
 * /me/notifications -- self notification routing (WATCHTOWER.md §2.6, §2.7,
 * T7). Every role reaches this (COME-ABOARD.md §3.2's self-scope carve-out,
 * same as /me itself): each member configures their OWN five channels, their
 * OWN per-event-type routing matrix, and their OWN quiet hours. Nothing here
 * ever reads or writes another user's row -- every query is scoped to
 * `locals.user.id`. Channel secrets round-trip through `redactChannelConfig`
 * (never a raw value back to the client); a blank secret field on save KEEPS
 * the stored value (the client has no real secret to resubmit).
 */
import { fail } from '@sveltejs/kit';
import { NOTIFICATION_EVENT_TYPES, EXTERNAL_NOTIFICATION_CHANNELS, type NotificationEventType } from '$lib/server/notify/types.js';
import { CHANNELS } from '$lib/server/notify/channels/index.js';
import {
	getUserChannelConfig,
	setUserChannelConfig,
	encryptUserSecretField,
	redactChannelConfig,
	type ExternalChannelId
} from '$lib/server/notify/config/channelConfig.js';
import {
	listSavedPreferences,
	setPreference,
	getLargeThresholdSats,
	getMilestonesForUser,
	type PreferenceConfig
} from '$lib/server/notify/config/prefs.js';
import { getQuietHoursWindow, setQuietHoursWindow, isValidQuietHoursWindow } from '$lib/server/notify/config/quietHours.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const userId = locals.user!.id;
	const saved = listSavedPreferences(userId);

	const matrix: Record<NotificationEventType, Record<ExternalChannelId, boolean>> = {} as Record<
		NotificationEventType,
		Record<ExternalChannelId, boolean>
	>;
	for (const eventType of NOTIFICATION_EVENT_TYPES) {
		const row = {} as Record<ExternalChannelId, boolean>;
		for (const channel of EXTERNAL_NOTIFICATION_CHANNELS) {
			row[channel] = saved.find((p) => p.eventType === eventType && p.channel === channel)?.enabled ?? false;
		}
		matrix[eventType] = row;
	}

	const channels = EXTERNAL_NOTIFICATION_CHANNELS.map((id) => ({
		id,
		label: CHANNELS[id].label,
		isConfigured: CHANNELS[id].isConfigured(userId),
		config: redactChannelConfig(id, getUserChannelConfig(userId, id))
	}));

	return {
		eventTypes: NOTIFICATION_EVENT_TYPES,
		channels,
		matrix,
		thresholdSats: getLargeThresholdSats(userId),
		confirmations: getMilestonesForUser(userId),
		quietHours: getQuietHoursWindow(userId)
	};
};

function str(data: FormData, key: string): string {
	return String(data.get(key) ?? '').trim();
}

export const actions: Actions = {
	/** The event-type x channel routing matrix, plus the tx_large threshold
	 *  and tx_confirmed milestone opt-ins (WATCHTOWER.md §1.4/§1.6, stored on
	 *  every channel row for the event type -- channel choice doesn't matter
	 *  for these two reads, per prefs.ts's own doc comment). */
	savePrefs: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();

		const thresholdRaw = str(data, 'thresholdSats');
		const thresholdSats = thresholdRaw ? Number(thresholdRaw) : undefined;
		if (thresholdRaw && (!Number.isFinite(thresholdSats) || (thresholdSats as number) <= 0)) {
			return fail(400, { error: 'the large-payment threshold must be a positive number of sats' });
		}

		const confirmations = [1, 3, 6].filter((n) => data.get(`confirm_${n}`) === 'on');

		for (const eventType of NOTIFICATION_EVENT_TYPES) {
			for (const channel of EXTERNAL_NOTIFICATION_CHANNELS) {
				const enabled = data.get(`pref_${eventType}_${channel}`) === 'on';
				let config: PreferenceConfig | undefined;
				if (eventType === 'tx_large' && thresholdSats) config = { thresholdSats };
				if (eventType === 'tx_confirmed' && confirmations.length > 0) config = { confirmations };
				setPreference(userId, eventType, channel, enabled, config);
			}
		}
		return { savedPrefs: true };
	},

	saveEmail: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const address = str(data, 'address');
		const smtpHost = str(data, 'smtpHost');
		const smtpPort = str(data, 'smtpPort');
		const smtpUser = str(data, 'smtpUser');
		const smtpTlsRaw = str(data, 'smtpTls');
		const smtpTls = smtpTlsRaw === 'tls' || smtpTlsRaw === 'none' ? smtpTlsRaw : 'starttls';
		const smtpPass = String(data.get('smtpPass') ?? '');

		const existing = getUserChannelConfig(userId, 'email') as
			| { address?: string; smtp?: { passEnc?: string } }
			| null;

		const cfg: Record<string, unknown> = {};
		if (address) cfg.address = address;
		if (smtpHost) {
			const passEnc = smtpPass ? encryptUserSecretField(smtpPass) : existing?.smtp?.passEnc;
			cfg.smtp = { host: smtpHost, port: Number(smtpPort) || 587, user: smtpUser || undefined, passEnc, tls: smtpTls };
		}
		setUserChannelConfig(userId, 'email', cfg);
		return { savedChannel: 'email' };
	},

	saveTelegram: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const chatId = str(data, 'chatId');
		setUserChannelConfig(userId, 'telegram', chatId ? { chatId } : {});
		return { savedChannel: 'telegram' };
	},

	saveNtfy: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const server = str(data, 'server');
		const topic = str(data, 'topic');
		const accessToken = String(data.get('accessToken') ?? '');

		const existing = getUserChannelConfig(userId, 'ntfy') as { accessTokenEnc?: string } | null;
		const accessTokenEnc = accessToken ? encryptUserSecretField(accessToken) : existing?.accessTokenEnc;

		const cfg: Record<string, unknown> = {};
		if (server) cfg.server = server;
		if (topic) cfg.topic = topic;
		if (accessTokenEnc) cfg.accessTokenEnc = accessTokenEnc;
		setUserChannelConfig(userId, 'ntfy', cfg);
		return { savedChannel: 'ntfy' };
	},

	saveNostr: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const recipientPubkey = str(data, 'recipientPubkey');
		const relaysRaw = str(data, 'relays');
		const relays = relaysRaw
			.split(/[\n,]/)
			.map((r) => r.trim())
			.filter(Boolean);

		const cfg: Record<string, unknown> = {};
		if (recipientPubkey) cfg.recipientPubkey = recipientPubkey;
		if (relays.length > 0) cfg.relays = relays;
		setUserChannelConfig(userId, 'nostr', cfg);
		return { savedChannel: 'nostr' };
	},

	saveWebhook: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const url = str(data, 'url');
		const secret = String(data.get('secret') ?? '');

		const existing = getUserChannelConfig(userId, 'webhook') as { secretEnc?: string } | null;
		const secretEnc = secret ? encryptUserSecretField(secret) : existing?.secretEnc;

		const cfg: Record<string, unknown> = {};
		if (url) cfg.url = url;
		if (secretEnc) cfg.secretEnc = secretEnc;
		setUserChannelConfig(userId, 'webhook', cfg);
		return { savedChannel: 'webhook' };
	},

	saveQuietHours: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const data = await request.formData();
		const enabled = data.get('quietEnabled') === 'on';
		if (!enabled) {
			setQuietHoursWindow(userId, null);
			return { savedQuietHours: true };
		}
		const window = { start: str(data, 'quietStart'), end: str(data, 'quietEnd') };
		if (!isValidQuietHoursWindow(window)) {
			return fail(400, { error: 'quiet hours needs two distinct start/end times' });
		}
		setQuietHoursWindow(userId, window);
		return { savedQuietHours: true };
	}
};
