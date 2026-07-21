/**
 * T7 acceptance (WATCHTOWER.md §2.3, §2.6, §2.7): /me/notifications is the
 * per-user routing/config surface. Three things proven at the ROUTE level
 * (the actual exported `load`/`actions`, not a re-implementation):
 *
 *  1. Redaction regression -- `load()`'s return value NEVER contains a
 *     secret value (plaintext or encrypted envelope) for any of the five
 *     channels, only presence booleans.
 *  2. The prefs matrix + tx_large threshold + tx_confirmed milestones
 *     persist and round-trip through `savePrefs`.
 *  3. A blank secret field on a resubmitted channel form KEEPS the stored
 *     secret (never clears it) -- the same rule §2.3 documents for
 *     instance settings, proven here for a per-user channel.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests, decryptSecret } from '$lib/server/notify/config/secrets.js';
import { getUserChannelConfig, decryptUserSecretField } from '$lib/server/notify/config/channelConfig.js';
import { load, actions } from './+page.server.js';

let userId: number;
let secretDir: string;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('mum', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-me-notifications-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
});
afterEach(() => {
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadEvent(): any {
	return { locals: { user: { id: userId, username: 'mum', role: 'member', mustResetPassword: false } } };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionEvent(fields: Record<string, string>): any {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	return {
		request: { formData: async () => form },
		locals: { user: { id: userId, username: 'mum', role: 'member', mustResetPassword: false } }
	};
}

describe('T7: /me/notifications load -- redaction regression (route-level)', () => {
	it('a fully-configured set of channels NEVER leaks a secret value in load()', async () => {
		await actions.saveEmail(
			actionEvent({ address: 'mum@example.com', smtpHost: 'smtp.example.com', smtpPort: '587', smtpPass: 'super-secret-smtp' })
		);
		await actions.saveNtfy(actionEvent({ server: 'https://ntfy.example.com', topic: 'hearth', accessToken: 'ntfy-secret-token' }));
		await actions.saveWebhook(actionEvent({ url: 'https://hooks.example.com/x', secret: 'webhook-hmac-secret' }));
		await actions.saveTelegram(actionEvent({ chatId: '555' }));
		await actions.saveNostr(actionEvent({ recipientPubkey: 'a'.repeat(64), relays: 'wss://relay.example.com' }));

		const data = (await load(loadEvent())) as Record<string, unknown>;
		const serialized = JSON.stringify(data);

		expect(serialized).not.toContain('super-secret-smtp');
		expect(serialized).not.toContain('ntfy-secret-token');
		expect(serialized).not.toContain('webhook-hmac-secret');

		const channels = data.channels as Array<{ id: string; config: Record<string, unknown> }>;
		const email = channels.find((c) => c.id === 'email')!.config as { smtp: { hasPass: boolean } | null };
		expect(email.smtp?.hasPass).toBe(true);
		const ntfy = channels.find((c) => c.id === 'ntfy')!.config as { hasAccessToken: boolean };
		expect(ntfy.hasAccessToken).toBe(true);
		const webhook = channels.find((c) => c.id === 'webhook')!.config as { hasSecret: boolean };
		expect(webhook.hasSecret).toBe(true);

		// Nothing anywhere in the payload is even a raw base64 envelope shape
		// (defense in depth beyond the plaintext check above).
		expect(serialized).not.toMatch(/"v":1,"iv":/);
	});

	it('never configured -- load() returns a safe empty shape per channel, not an error', async () => {
		const data = (await load(loadEvent())) as Record<string, unknown>;
		const channels = data.channels as Array<{ id: string; isConfigured: boolean; config: Record<string, unknown> }>;
		for (const c of channels) {
			expect(c.isConfigured).toBe(false);
		}
	});
});

describe('T7: /me/notifications savePrefs -- matrix + threshold + milestones round-trip', () => {
	it('persists the routing matrix, the tx_large threshold, and tx_confirmed milestones', async () => {
		await actions.savePrefs(
			actionEvent({
				pref_tx_received_webhook: 'on',
				pref_tx_confirmed_email: 'on',
				thresholdSats: '2500000',
				confirm_1: 'on',
				confirm_3: 'on'
			})
		);

		const data = (await load(loadEvent())) as {
			matrix: Record<string, Record<string, boolean>>;
			thresholdSats: number | null;
			confirmations: number[];
		};
		expect(data.matrix.tx_received.webhook).toBe(true);
		expect(data.matrix.tx_received.email).toBe(false);
		expect(data.matrix.tx_confirmed.email).toBe(true);
		expect(data.thresholdSats).toBe(2_500_000);
		expect(data.confirmations.sort()).toEqual([1, 3]);
	});

	it('an all-unchecked submit clears every routing cell back to off', async () => {
		await actions.savePrefs(actionEvent({ pref_tx_received_webhook: 'on' }));
		await actions.savePrefs(actionEvent({})); // resubmit with nothing checked
		const data = (await load(loadEvent())) as { matrix: Record<string, Record<string, boolean>> };
		expect(data.matrix.tx_received.webhook).toBe(false);
	});
});

describe('T7: channel config save -- a blank secret KEEPS the stored value', () => {
	it('email: resubmitting with a blank password keeps the original, still decryptable', async () => {
		await actions.saveEmail(
			actionEvent({ address: 'mum@example.com', smtpHost: 'smtp.example.com', smtpPort: '587', smtpPass: 'first-password' })
		);
		await actions.saveEmail(
			actionEvent({ address: 'mum@example.com', smtpHost: 'smtp.example.com', smtpPort: '587', smtpPass: '' })
		);
		// Verify the STORED envelope, not the top-level `field` accessor --
		// email's personal-SMTP password is nested at `smtp.passEnc`, one
		// level deeper than `decryptUserSecretField`'s single-field lookup
		// reaches (that mismatch is a separate bug, fixed alongside this
		// task -- see channels/email.spec.ts's regression test).
		const stored = getUserChannelConfig(userId, 'email') as { smtp?: { passEnc?: string } };
		expect(stored.smtp?.passEnc).toBeTruthy();
		expect(decryptSecret(stored.smtp!.passEnc!)).toBe('first-password');

		const data = (await load(loadEvent())) as {
			channels: Array<{ id: string; config: { smtp: { hasPass: boolean } | null } }>;
		};
		const email = data.channels.find((c) => c.id === 'email')!;
		expect(email.config.smtp?.hasPass).toBe(true);
	});

	it('webhook: resubmitting with a blank secret keeps the stored HMAC secret decryptable', async () => {
		await actions.saveWebhook(actionEvent({ url: 'https://hooks.example.com/x', secret: 'first-secret' }));
		await actions.saveWebhook(actionEvent({ url: 'https://hooks.example.com/x', secret: '' }));
		expect(decryptUserSecretField(userId, 'webhook', 'secretEnc')).toBe('first-secret');

		const data = (await load(loadEvent())) as {
			channels: Array<{ id: string; config: { hasSecret: boolean } }>;
		};
		const webhook = data.channels.find((c) => c.id === 'webhook')!;
		expect(webhook.config.hasSecret).toBe(true);
	});
});

describe('T7: quiet hours save/round-trip', () => {
	it('enabling saves a window that load() returns', async () => {
		await actions.saveQuietHours(actionEvent({ quietEnabled: 'on', quietStart: '22:00', quietEnd: '07:00' }));
		const data = (await load(loadEvent())) as { quietHours: { start: string; end: string } | null };
		expect(data.quietHours).toEqual({ start: '22:00', end: '07:00' });
	});

	it('unchecking clears the window back to off', async () => {
		await actions.saveQuietHours(actionEvent({ quietEnabled: 'on', quietStart: '22:00', quietEnd: '07:00' }));
		await actions.saveQuietHours(actionEvent({}));
		const data = (await load(loadEvent())) as { quietHours: unknown };
		expect(data.quietHours).toBeNull();
	});
});
