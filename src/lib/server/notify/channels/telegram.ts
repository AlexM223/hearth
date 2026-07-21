/**
 * The Telegram channel (WATCHTOWER.md §2.2): one bot per instance
 * (`telegram_bot_token`, an instance secret), POST sendMessage per user
 * chatId. Telegram's own API is not a user-supplied SSRF target (the URL is
 * always api.telegram.org), so no SSRF guard is needed here -- only
 * webhook/ntfy/nostr-relay targets are user-supplied.
 */
import { renderTelegram } from '../queue/render.js';
import { getUserChannelConfig, getInstanceSecret, getNotifyOrigin } from '../config/channelConfig.js';
import type { ChannelSendResult, NotificationChannelPlugin, NotificationPayload } from '../types.js';
import { REQUEST_TIMEOUT_MS } from './ssrf.js';

interface TelegramConfig {
	chatId?: string | number;
}

function config(userId: number): TelegramConfig | null {
	return getUserChannelConfig(userId, 'telegram') as TelegramConfig | null;
}

async function sendTo(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const cfg = config(userId);
	if (!cfg?.chatId) return { ok: false, retryable: false, error: 'no Telegram chat linked' };
	const token = getInstanceSecret('telegram_bot_token');
	if (!token) return { ok: false, retryable: false, error: 'no Telegram bot token configured on this instance' };

	const html = renderTelegram(payload, getNotifyOrigin());
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: cfg.chatId,
				text: html,
				parse_mode: 'HTML',
				disable_web_page_preview: true
			}),
			signal: controller.signal
		});
	} catch (e) {
		return { ok: false, retryable: true, error: String(e) };
	} finally {
		clearTimeout(timer);
	}

	if (res.ok) return { ok: true };
	// 401/403 -- bad token or the user has never /start'ed the bot (config,
	// not transient). 429 -- rate limited, retryable. 5xx -- Telegram's own
	// outage, retryable.
	if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, error: `HTTP ${res.status}` };
	return { ok: false, retryable: true, error: `HTTP ${res.status}` };
}

export const telegram: NotificationChannelPlugin = {
	id: 'telegram',
	label: 'Telegram',
	send: sendTo,
	async test(userId) {
		return sendTo(userId, {
			type: 'tx_received',
			userId,
			level: 'info',
			title: 'Hearth test notification',
			body: 'This is a test notification from your Hearth watchtower.'
		});
	},
	isConfigured(userId) {
		return Boolean(config(userId)?.chatId) && Boolean(getInstanceSecret('telegram_bot_token'));
	}
};
