/**
 * Per-user channel connection config + instance-wide notify settings
 * (WATCHTOWER.md §2.2, §2.7). Non-secret fields (destination address,
 * chatId, topic/server, recipient pubkey, relays, webhook url) live as
 * plaintext JSON; secret fields (`smtp_pass`, personal-SMTP `passEnc`,
 * `telegram_bot_token`, ntfy `accessTokenEnc`, webhook `secretEnc`, the
 * Nostr sender identity) are AES-256-GCM envelopes via secrets.ts. Instance
 * non-secret settings reuse the existing `meta` kv table (migration 001);
 * instance secrets live in `instance_secrets` (migration 008).
 *
 * This module is the read/write core AND (T7) the redaction layer: every
 * channel adapter reads the un-redacted config through the functions above
 * directly, server-side only; `redactChannelConfig` /
 * `getPublicInstanceNotificationSettings` below are the ONLY functions
 * allowed to hand a channel config to a client, and never include a secret
 * value -- only presence booleans.
 */
import { getDb, getMeta, setMeta } from '../../db/index.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import type { NotificationChannelId } from '../types.js';

export type ExternalChannelId = Exclude<NotificationChannelId, 'inapp'>;

/** Per-user, per-channel config JSON (secret fields are `...Enc` envelopes;
 *  callers decrypt the specific field they need). Null if never configured. */
export function getUserChannelConfig(userId: number, channel: ExternalChannelId): Record<string, unknown> | null {
	const row = getDb()
		.prepare('SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = ?')
		.get(userId, channel) as { config: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.config);
	} catch {
		return null;
	}
}

export function setUserChannelConfig(userId: number, channel: ExternalChannelId, config: Record<string, unknown>): void {
	getDb()
		.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, channel) DO UPDATE SET config = excluded.config`
		)
		.run(userId, channel, JSON.stringify(config));
}

/** Decrypts a specific `...Enc` field from a user's channel config. Fails
 *  closed: an undecryptable value returns null (never throws into a caller
 *  that isn't ready for it), matching secrets.ts's own posture. */
export function decryptUserSecretField(userId: number, channel: ExternalChannelId, field: string): string | null {
	const cfg = getUserChannelConfig(userId, channel);
	const value = cfg?.[field];
	if (typeof value !== 'string' || value.length === 0) return null;
	try {
		return decryptSecret(value);
	} catch {
		return null;
	}
}

export function encryptUserSecretField(plain: string): string {
	return encryptSecret(plain);
}

// ------------------------------------------------------ instance-wide config

export function getInstanceMeta(key: string): string | null {
	return getMeta(key);
}
export function setInstanceMeta(key: string, value: string): void {
	setMeta(key, value);
}

export function getInstanceSecret(key: string): string | null {
	const row = getDb().prepare('SELECT value_enc FROM instance_secrets WHERE key = ?').get(key) as
		| { value_enc: string }
		| undefined;
	if (!row) return null;
	try {
		return decryptSecret(row.value_enc);
	} catch {
		return null;
	}
}

export function setInstanceSecret(key: string, plain: string): void {
	getDb()
		.prepare(
			`INSERT INTO instance_secrets (key, value_enc) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc`
		)
		.run(key, encryptSecret(plain));
}

/** Presence check WITHOUT decrypting -- a Settings "configured" checkbox
 *  needs only to know a secret is on file, never its value or even whether
 *  it currently decrypts (WATCHTOWER.md §2.3: a present-but-undecryptable
 *  secret is an "investigate" state, not "absent" -- surfacing it as absent
 *  here would invite an operator to silently re-mint over it from the UI). */
export function hasInstanceSecret(key: string): boolean {
	const row = getDb().prepare('SELECT 1 FROM instance_secrets WHERE key = ?').get(key);
	return row !== undefined;
}

// ---------------------------------------------------- redaction (T7, §2.3)

/**
 * Redaction to the client (WATCHTOWER.md §2.3's `redactChannelConfig`): every
 * secret field is turned into a presence boolean and the value dropped, so a
 * Settings form round-trips config without ever receiving a secret back out
 * (a blank submit on the form = "keep the stored value"). Add a new secret
 * field HERE and every call site inherits the redaction -- this is the one
 * place a per-user channel config is allowed to reach a client.
 */
export interface RedactedEmailConfig {
	address: string | null;
	smtp: { host: string; port: number; user: string | null; tls: 'starttls' | 'tls' | 'none'; hasPass: boolean } | null;
}
export interface RedactedTelegramConfig {
	chatId: string | null;
}
export interface RedactedNtfyConfig {
	server: string | null;
	topic: string | null;
	hasAccessToken: boolean;
}
export interface RedactedNostrConfig {
	recipientPubkey: string | null;
	relays: string[];
}
export interface RedactedWebhookConfig {
	url: string | null;
	hasSecret: boolean;
}
export type RedactedChannelConfig =
	| RedactedEmailConfig
	| RedactedTelegramConfig
	| RedactedNtfyConfig
	| RedactedNostrConfig
	| RedactedWebhookConfig;

export function redactChannelConfig(channel: 'email', cfg: Record<string, unknown> | null): RedactedEmailConfig;
export function redactChannelConfig(channel: 'telegram', cfg: Record<string, unknown> | null): RedactedTelegramConfig;
export function redactChannelConfig(channel: 'ntfy', cfg: Record<string, unknown> | null): RedactedNtfyConfig;
export function redactChannelConfig(channel: 'nostr', cfg: Record<string, unknown> | null): RedactedNostrConfig;
export function redactChannelConfig(channel: 'webhook', cfg: Record<string, unknown> | null): RedactedWebhookConfig;
// General overload -- for a call site iterating EXTERNAL_NOTIFICATION_CHANNELS
// with a variable (not a literal) channel id, where the union return type is
// the correct/only answerable shape.
export function redactChannelConfig(channel: ExternalChannelId, cfg: Record<string, unknown> | null): RedactedChannelConfig;
export function redactChannelConfig(
	channel: ExternalChannelId,
	cfg: Record<string, unknown> | null
): RedactedChannelConfig {
	switch (channel) {
		case 'email': {
			const smtp = (cfg?.smtp ?? null) as
				| { host?: string; port?: number; user?: string; passEnc?: string; tls?: string }
				| null;
			const out: RedactedEmailConfig = {
				address: typeof cfg?.address === 'string' ? cfg.address : null,
				smtp:
					smtp?.host && typeof smtp.host === 'string'
						? {
								host: smtp.host,
								port: typeof smtp.port === 'number' ? smtp.port : 587,
								user: typeof smtp.user === 'string' ? smtp.user : null,
								tls: smtp.tls === 'tls' || smtp.tls === 'none' ? smtp.tls : 'starttls',
								hasPass: Boolean(smtp.passEnc)
							}
						: null
			};
			return out;
		}
		case 'telegram':
			return { chatId: cfg?.chatId != null ? String(cfg.chatId) : null } satisfies RedactedTelegramConfig;
		case 'ntfy':
			return {
				server: typeof cfg?.server === 'string' ? cfg.server : null,
				topic: typeof cfg?.topic === 'string' ? cfg.topic : null,
				hasAccessToken: Boolean(cfg?.accessTokenEnc)
			} satisfies RedactedNtfyConfig;
		case 'nostr':
			return {
				recipientPubkey: typeof cfg?.recipientPubkey === 'string' ? cfg.recipientPubkey : null,
				relays: Array.isArray(cfg?.relays) ? (cfg.relays as unknown[]).filter((r): r is string => typeof r === 'string') : []
			} satisfies RedactedNostrConfig;
		case 'webhook':
			return {
				url: typeof cfg?.url === 'string' ? cfg.url : null,
				hasSecret: Boolean(cfg?.secretEnc)
			} satisfies RedactedWebhookConfig;
	}
}

/** Instance-wide notify settings, redacted the same way (WATCHTOWER.md
 *  §2.3's `getPublicInstanceNotificationSettings`): `hasSmtpPass`/
 *  `hasTelegramBotToken` presence flags, never the secret value. */
export interface PublicInstanceNotificationSettings {
	smtp: {
		host: string | null;
		port: number;
		user: string | null;
		from: string | null;
		tls: 'starttls' | 'tls' | 'none';
		hasPass: boolean;
	};
	telegram: { hasBotToken: boolean };
	ntfy: { defaultServer: string | null };
	nostr: { defaultRelays: string[] };
	webhook: { allowPrivateTargets: boolean };
}

export function getPublicInstanceNotificationSettings(): PublicInstanceNotificationSettings {
	const relaysRaw = getMeta('nostr_default_relays');
	let defaultRelays: string[] = [];
	if (relaysRaw) {
		try {
			const parsed = JSON.parse(relaysRaw);
			if (Array.isArray(parsed)) defaultRelays = parsed.filter((r): r is string => typeof r === 'string');
		} catch {
			defaultRelays = [];
		}
	}
	const tls = getMeta('smtp_tls');
	return {
		smtp: {
			host: getMeta('smtp_host'),
			port: Number(getMeta('smtp_port') ?? '587'),
			user: getMeta('smtp_user'),
			from: getMeta('smtp_from'),
			tls: tls === 'tls' || tls === 'none' ? tls : 'starttls',
			hasPass: hasInstanceSecret('smtp_pass')
		},
		telegram: { hasBotToken: hasInstanceSecret('telegram_bot_token') },
		ntfy: { defaultServer: getMeta('ntfy_default_server') },
		nostr: { defaultRelays },
		webhook: { allowPrivateTargets: getMeta('webhook_allow_private_targets') === '1' }
	};
}

/** Owner-only write path for instance notify settings (T7). Secret fields
 *  (`smtpPass`, `telegramBotToken`) follow the Settings-form convention: a
 *  falsy/blank value means "keep the stored value" -- a client never has the
 *  real secret to round-trip, so it can only ever submit blank-or-new,
 *  never blank-meaning-clear. Non-secret fields overwrite unconditionally
 *  when present (the form always submits its full current state). */
export interface InstanceNotificationSettingsInput {
	smtpHost?: string;
	smtpPort?: number;
	smtpUser?: string;
	smtpFrom?: string;
	smtpTls?: 'starttls' | 'tls' | 'none';
	smtpPass?: string;
	telegramBotToken?: string;
	ntfyDefaultServer?: string;
	nostrDefaultRelays?: string[];
	webhookAllowPrivateTargets?: boolean;
}

export function setInstanceNotificationSettings(input: InstanceNotificationSettingsInput): void {
	if (input.smtpHost !== undefined) setMeta('smtp_host', input.smtpHost);
	if (input.smtpPort !== undefined) setMeta('smtp_port', String(input.smtpPort));
	if (input.smtpUser !== undefined) setMeta('smtp_user', input.smtpUser);
	if (input.smtpFrom !== undefined) setMeta('smtp_from', input.smtpFrom);
	if (input.smtpTls !== undefined) setMeta('smtp_tls', input.smtpTls);
	if (input.smtpPass) setInstanceSecret('smtp_pass', input.smtpPass);
	if (input.telegramBotToken) setInstanceSecret('telegram_bot_token', input.telegramBotToken);
	if (input.ntfyDefaultServer !== undefined) setMeta('ntfy_default_server', input.ntfyDefaultServer);
	if (input.nostrDefaultRelays !== undefined) setMeta('nostr_default_relays', JSON.stringify(input.nostrDefaultRelays));
	if (input.webhookAllowPrivateTargets !== undefined) {
		setMeta('webhook_allow_private_targets', input.webhookAllowPrivateTargets ? '1' : '0');
	}
}

// -------------------------------------------------------------- origin cache

// HEARTH_ORIGIN (DECISIONS.md §5.3) is read from config/index.ts at boot and
// handed in here once -- notify/ never reads process.env directly (the
// config module's own rule). Used by render.ts's absoluteNotificationLink so
// every out-of-app channel resolves a relative deep-link correctly.
let cachedOrigin: string | null = null;

export function initNotifyOrigin(origin: string | null): void {
	cachedOrigin = origin;
}

export function getNotifyOrigin(): string | null {
	return cachedOrigin;
}
