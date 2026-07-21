/**
 * Settings -> Notifications -- instance-wide channel config (WATCHTOWER.md
 * §2.2, §2.3, §2.6, T7). Owner-only: this whole page lives under
 * `/settings/**`, which `hooks.server.ts`'s `requiresOwnerPage` already
 * redirects a Member/Guest away from before this load ever runs (the same
 * gate `/settings/members` relies on) -- no separate `requireRole` call
 * needed here, matching that page's convention. `setInstanceNotificationSettings`
 * applies the Settings-form "blank secret = keep the stored value" rule, so
 * this action can always be safely re-submitted with the redacted form data
 * `load()` returned.
 */
import {
	getPublicInstanceNotificationSettings,
	setInstanceNotificationSettings
} from '$lib/server/notify/config/channelConfig.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return { settings: getPublicInstanceNotificationSettings() };
};

export const actions: Actions = {
	save: async ({ request }) => {
		const data = await request.formData();
		const smtpTlsRaw = String(data.get('smtpTls') ?? 'starttls');

		setInstanceNotificationSettings({
			smtpHost: String(data.get('smtpHost') ?? '').trim(),
			smtpPort: Number(data.get('smtpPort')) || 587,
			smtpUser: String(data.get('smtpUser') ?? '').trim(),
			smtpFrom: String(data.get('smtpFrom') ?? '').trim(),
			smtpTls: smtpTlsRaw === 'tls' || smtpTlsRaw === 'none' ? smtpTlsRaw : 'starttls',
			smtpPass: String(data.get('smtpPass') ?? ''),
			telegramBotToken: String(data.get('telegramBotToken') ?? ''),
			ntfyDefaultServer: String(data.get('ntfyDefaultServer') ?? '').trim(),
			nostrDefaultRelays: String(data.get('nostrDefaultRelays') ?? '')
				.split(/[\n,]/)
				.map((r) => r.trim())
				.filter(Boolean),
			webhookAllowPrivateTargets: data.get('webhookAllowPrivateTargets') === 'on'
		});
		return { saved: true };
	}
};
