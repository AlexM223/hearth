/**
 * T7 acceptance (WATCHTOWER.md §2.3): redaction never leaks a secret. Every
 * secret field (`smtp.passEnc`, `accessTokenEnc`, `secretEnc`, the instance
 * `smtp_pass`/`telegram_bot_token`) turns into a presence boolean and the
 * value itself is dropped -- proven per channel, plus the instance-settings
 * equivalent.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from './secrets.js';
import {
	setUserChannelConfig,
	getUserChannelConfig,
	encryptUserSecretField,
	redactChannelConfig,
	getPublicInstanceNotificationSettings,
	setInstanceNotificationSettings,
	hasInstanceSecret
} from './channelConfig.js';

let userId: number;
let secretDir: string;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-channelconfig-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
});
afterEach(() => {
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

describe('T7: redactChannelConfig -- per-channel secret redaction', () => {
	it('email: never returns smtp.passEnc, only hasPass', () => {
		const passEnc = encryptUserSecretField('super-secret-relay-password');
		setUserChannelConfig(userId, 'email', {
			address: 'me@example.com',
			smtp: { host: 'smtp.example.com', port: 465, user: 'me', passEnc, tls: 'tls' }
		});
		const redacted = redactChannelConfig('email', getUserChannelConfig(userId, 'email'));
		expect(redacted.address).toBe('me@example.com');
		expect(redacted.smtp).toEqual({ host: 'smtp.example.com', port: 465, user: 'me', tls: 'tls', hasPass: true });
		expect(JSON.stringify(redacted)).not.toContain('super-secret-relay-password');
		expect(JSON.stringify(redacted)).not.toContain(passEnc);
	});

	it('email: no personal SMTP override -> smtp is null, hasPass never asserted true', () => {
		setUserChannelConfig(userId, 'email', { address: 'me@example.com' });
		const redacted = redactChannelConfig('email', getUserChannelConfig(userId, 'email'));
		expect(redacted.smtp).toBeNull();
	});

	it('never configured (null config) -> a safe all-empty shape, not a throw', () => {
		expect(redactChannelConfig('email', null)).toEqual({ address: null, smtp: null });
		expect(redactChannelConfig('telegram', null)).toEqual({ chatId: null });
		expect(redactChannelConfig('ntfy', null)).toEqual({ server: null, topic: null, hasAccessToken: false });
		expect(redactChannelConfig('nostr', null)).toEqual({ recipientPubkey: null, relays: [] });
		expect(redactChannelConfig('webhook', null)).toEqual({ url: null, hasSecret: false });
	});

	it('ntfy: never returns accessTokenEnc, only hasAccessToken', () => {
		const accessTokenEnc = encryptUserSecretField('ntfy-access-token');
		setUserChannelConfig(userId, 'ntfy', { server: 'https://ntfy.example.com', topic: 'hearth', accessTokenEnc });
		const redacted = redactChannelConfig('ntfy', getUserChannelConfig(userId, 'ntfy'));
		expect(redacted).toEqual({ server: 'https://ntfy.example.com', topic: 'hearth', hasAccessToken: true });
		expect(JSON.stringify(redacted)).not.toContain(accessTokenEnc);
	});

	it('webhook: never returns secretEnc, only hasSecret', () => {
		const secretEnc = encryptUserSecretField('hmac-signing-secret');
		setUserChannelConfig(userId, 'webhook', { url: 'https://hooks.example.com/x', secretEnc });
		const redacted = redactChannelConfig('webhook', getUserChannelConfig(userId, 'webhook'));
		expect(redacted).toEqual({ url: 'https://hooks.example.com/x', hasSecret: true });
		expect(JSON.stringify(redacted)).not.toContain(secretEnc);
	});

	it('telegram and nostr carry no user-level secret to redact (pass through)', () => {
		setUserChannelConfig(userId, 'telegram', { chatId: '12345' });
		expect(redactChannelConfig('telegram', getUserChannelConfig(userId, 'telegram'))).toEqual({ chatId: '12345' });

		setUserChannelConfig(userId, 'nostr', { recipientPubkey: 'a'.repeat(64), relays: ['wss://relay.example.com'] });
		expect(redactChannelConfig('nostr', getUserChannelConfig(userId, 'nostr'))).toEqual({
			recipientPubkey: 'a'.repeat(64),
			relays: ['wss://relay.example.com']
		});
	});
});

describe('T7: getPublicInstanceNotificationSettings / setInstanceNotificationSettings', () => {
	it('defaults: no secret configured, presence flags false, non-secret fields null/default', () => {
		const settings = getPublicInstanceNotificationSettings();
		expect(settings.smtp.hasPass).toBe(false);
		expect(settings.smtp.host).toBeNull();
		expect(settings.smtp.tls).toBe('starttls');
		expect(settings.telegram.hasBotToken).toBe(false);
		expect(settings.nostr.defaultRelays).toEqual([]);
		expect(settings.webhook.allowPrivateTargets).toBe(false);
	});

	it('round-trips non-secret fields and NEVER echoes a set secret back', () => {
		setInstanceNotificationSettings({
			smtpHost: 'smtp.example.com',
			smtpPort: 587,
			smtpUser: 'hearth@example.com',
			smtpFrom: 'hearth@example.com',
			smtpTls: 'starttls',
			smtpPass: 'the-real-relay-password',
			telegramBotToken: 'the-real-bot-token',
			ntfyDefaultServer: 'https://ntfy.example.com',
			nostrDefaultRelays: ['wss://relay1.example.com', 'wss://relay2.example.com'],
			webhookAllowPrivateTargets: true
		});

		const settings = getPublicInstanceNotificationSettings();
		expect(settings.smtp.host).toBe('smtp.example.com');
		expect(settings.smtp.hasPass).toBe(true);
		expect(settings.telegram.hasBotToken).toBe(true);
		expect(settings.nostr.defaultRelays).toEqual(['wss://relay1.example.com', 'wss://relay2.example.com']);
		expect(settings.webhook.allowPrivateTargets).toBe(true);

		expect(JSON.stringify(settings)).not.toContain('the-real-relay-password');
		expect(JSON.stringify(settings)).not.toContain('the-real-bot-token');
	});

	it('a blank secret on a later save KEEPS the stored secret (never clears it)', () => {
		setInstanceNotificationSettings({ smtpPass: 'first-password' });
		expect(hasInstanceSecret('smtp_pass')).toBe(true);

		// Simulates a Settings form re-submit with the (redacted, blank) password field.
		setInstanceNotificationSettings({ smtpHost: 'smtp2.example.com', smtpPass: '' });
		expect(hasInstanceSecret('smtp_pass')).toBe(true);
		expect(getPublicInstanceNotificationSettings().smtp.host).toBe('smtp2.example.com');
	});
});
