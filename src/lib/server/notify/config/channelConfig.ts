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
 * This module is the read/write core; redaction for the client (never
 * sending a secret value back out) is config/prefs.ts's Settings-facing
 * layer (T7) -- every channel adapter reads through here directly, server-
 * side only.
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
