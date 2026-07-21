/**
 * The ntfy channel (WATCHTOWER.md §2.2): POST JSON {topic,title,message,
 * priority,click} to the user's ntfy server/topic, through the mandatory
 * SSRF guard (ntfy servers are frequently self-hosted -- exactly the
 * SSRF-relevant case).
 */
import { safeFetch, SsrfRejectedError, REQUEST_TIMEOUT_MS } from './ssrf.js';
import { renderNtfy } from '../queue/render.js';
import { getUserChannelConfig, decryptUserSecretField, getNotifyOrigin, getInstanceMeta } from '../config/channelConfig.js';
import type { ChannelSendResult, NotificationChannelPlugin, NotificationPayload } from '../types.js';

interface NtfyConfig {
	server?: string;
	topic?: string;
	accessTokenEnc?: string;
}

function config(userId: number): NtfyConfig | null {
	return getUserChannelConfig(userId, 'ntfy') as NtfyConfig | null;
}

function resolveServer(cfg: NtfyConfig): string {
	return cfg.server || getInstanceMeta('ntfy_default_server') || 'https://ntfy.sh';
}

function allowPrivateTargets(): boolean {
	return getInstanceMeta('webhook_allow_private_targets') === '1'; // shared instance escape hatch
}

async function sendTo(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const cfg = config(userId);
	if (!cfg?.topic) return { ok: false, retryable: false, error: 'no ntfy topic configured' };

	const server = resolveServer(cfg);
	const rendered = renderNtfy(payload, getNotifyOrigin());
	const body = JSON.stringify({ topic: cfg.topic, ...rendered });

	const headers: Record<string, string> = { 'content-type': 'application/json' };
	const token = cfg.accessTokenEnc ? decryptUserSecretField(userId, 'ntfy', 'accessTokenEnc') : null;
	if (token) headers.authorization = `Bearer ${token}`;

	let res: Response;
	try {
		res = await safeFetch(server, {
			method: 'POST',
			headers,
			body,
			timeoutMs: REQUEST_TIMEOUT_MS,
			allowPrivate: allowPrivateTargets()
		});
	} catch (e) {
		if (e instanceof SsrfRejectedError) return { ok: false, retryable: false, error: e.message };
		return { ok: false, retryable: true, error: String(e) };
	}

	if (res.ok) return { ok: true };
	if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, error: `HTTP ${res.status}` };
	return { ok: false, retryable: true, error: `HTTP ${res.status}` };
}

export const ntfy: NotificationChannelPlugin = {
	id: 'ntfy',
	label: 'ntfy',
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
		return Boolean(config(userId)?.topic);
	}
};
