/**
 * The webhook channel (WATCHTOWER.md §2.2, §2.5): POST a stable JSON body,
 * HMAC-signed over the exact bytes sent, through the mandatory SSRF guard.
 */
import { createHmac } from 'node:crypto';
import { safeFetch, SsrfRejectedError, REQUEST_TIMEOUT_MS } from './ssrf.js';
import { renderWebhookBody } from '../queue/render.js';
import { getUserChannelConfig, decryptUserSecretField, getNotifyOrigin, getInstanceMeta } from '../config/channelConfig.js';
import type { ChannelSendResult, NotificationChannelPlugin, NotificationPayload } from '../types.js';

interface WebhookConfig {
	url?: string;
	secretEnc?: string;
}

function config(userId: number): WebhookConfig | null {
	return getUserChannelConfig(userId, 'webhook') as WebhookConfig | null;
}

function allowPrivateTargets(): boolean {
	return getInstanceMeta('webhook_allow_private_targets') === '1';
}

async function sendTo(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const cfg = config(userId);
	if (!cfg?.url) return { ok: false, retryable: false, error: 'no webhook URL configured' };

	const body = renderWebhookBody(payload, getNotifyOrigin());
	// Serialize ONCE; sign those EXACT bytes (the GitHub/Stripe construction) --
	// never re-serialize after signing, which could produce different bytes.
	const rawBody = JSON.stringify(body);
	const headers: Record<string, string> = { 'content-type': 'application/json' };

	const secret = cfg.secretEnc ? decryptUserSecretField(userId, 'webhook', 'secretEnc') : null;
	if (secret) {
		const sig = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
		headers['X-Hearth-Signature'] = `sha256=${sig}`;
	}

	let res: Response;
	try {
		res = await safeFetch(cfg.url, {
			method: 'POST',
			headers,
			body: rawBody,
			timeoutMs: REQUEST_TIMEOUT_MS,
			allowPrivate: allowPrivateTargets()
		});
	} catch (e) {
		if (e instanceof SsrfRejectedError) return { ok: false, retryable: false, error: e.message };
		return { ok: false, retryable: true, error: String(e) };
	}

	if (res.ok) return { ok: true };
	// A non-2xx from the receiving endpoint is transient/config-recoverable --
	// retryable (WATCHTOWER.md §2.2).
	return { ok: false, retryable: true, error: `HTTP ${res.status}` };
}

export const webhook: NotificationChannelPlugin = {
	id: 'webhook',
	label: 'Webhook',
	send: sendTo,
	async test(userId) {
		return sendTo(userId, {
			type: 'tx_received',
			userId,
			level: 'info',
			title: 'Hearth test notification',
			body: 'This is a test notification from your Hearth watchtower.',
			detail: { test: true }
		});
	},
	isConfigured(userId) {
		return Boolean(config(userId)?.url);
	}
};

/** Verifies an `X-Hearth-Signature: sha256=<hex>` header against the raw
 *  received bytes -- exported for tests and for a future receiver-side
 *  reference (Hearth is the SENDER; this is here for symmetry/testability). */
export function verifyWebhookSignature(rawBody: string, secret: string, header: string | null): boolean {
	if (!header) return false;
	const m = /^sha256=([0-9a-f]+)$/i.exec(header.trim());
	if (!m) return false;
	const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
	return timingSafeEqualHex(expected, m[1]);
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
