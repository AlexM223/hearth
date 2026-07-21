/**
 * T6 acceptance (WATCHTOWER.md §2.2, §2.5, §6.4): webhook send success,
 * the HMAC signature verifies against the RAW bytes, SSRF rejection is
 * non-retryable, a non-2xx response is retryable, isConfigured reflects
 * saved config, test() uses the identical send path.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, setMeta } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from '../config/secrets.js';
import { setUserChannelConfig, encryptUserSecretField, initNotifyOrigin } from '../config/channelConfig.js';
import { webhook, verifyWebhookSignature } from './webhook.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userId: number;
let secretDir: string;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-webhook-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initNotifyOrigin('https://hearth.example');
});
afterEach(() => {
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
	const server = http.createServer(handler);
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({ url: `http://127.0.0.1:${port}/hook`, close: () => server.close() });
		});
	});
}

describe('T6: webhook channel', () => {
	it('isConfigured is false with no config, true once a URL is saved', () => {
		expect(webhook.isConfigured(userId)).toBe(false);
		setUserChannelConfig(userId, 'webhook', { url: 'http://127.0.0.1:1/hook' });
		expect(webhook.isConfigured(userId)).toBe(true);
	});

	it('sends a POST with the correctly-signed HMAC header, verifiable against the raw bytes', async () => {
		setMeta('webhook_allow_private_targets', '1');
		let receivedBody = '';
		let receivedSig: string | null = null;
		const secret = 'my-webhook-secret';
		const { url, close } = await startServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				receivedBody = Buffer.concat(chunks).toString('utf8');
				receivedSig = req.headers['x-hearth-signature'] as string;
				res.writeHead(200);
				res.end('ok');
			});
		});
		setUserChannelConfig(userId, 'webhook', { url, secretEnc: encryptUserSecretField(secret) });

		const result = await webhook.send(userId, {
			type: 'tx_received',
			userId,
			level: 'success',
			title: 'Payment received',
			body: 'You received 0.001 BTC.',
			link: '/wallets/1'
		});

		expect(result.ok).toBe(true);
		expect(verifyWebhookSignature(receivedBody, secret, receivedSig)).toBe(true);
		expect(JSON.parse(receivedBody).title).toBe('Payment received');
		expect(JSON.parse(receivedBody).linkAbsolute).toBe('https://hearth.example/wallets/1');
		close();
	});

	it('a wrong secret fails HMAC verification (tamper/misconfig detection)', async () => {
		setMeta('webhook_allow_private_targets', '1');
		let receivedBody = '';
		let receivedSig: string | null = null;
		const { url, close } = await startServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				receivedBody = Buffer.concat(chunks).toString('utf8');
				receivedSig = req.headers['x-hearth-signature'] as string;
				res.writeHead(200);
				res.end('ok');
			});
		});
		setUserChannelConfig(userId, 'webhook', { url, secretEnc: encryptUserSecretField('correct-secret') });
		await webhook.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(verifyWebhookSignature(receivedBody, 'wrong-secret', receivedSig)).toBe(false);
		close();
	});

	it('a non-2xx response is retryable', async () => {
		setMeta('webhook_allow_private_targets', '1');
		const { url, close } = await startServer((_req, res) => {
			res.writeHead(500);
			res.end('server error');
		});
		setUserChannelConfig(userId, 'webhook', { url });
		const result = await webhook.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
		close();
	});

	it('an SSRF-blocked target is non-retryable', async () => {
		setUserChannelConfig(userId, 'webhook', { url: 'http://127.0.0.1:1/hook' }); // private range, allowPrivate NOT set
		const result = await webhook.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it('with no URL configured, fails non-retryable (config error)', async () => {
		const result = await webhook.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it('test() uses the identical send path', async () => {
		setMeta('webhook_allow_private_targets', '1');
		const { url, close } = await startServer((_req, res) => {
			res.writeHead(200);
			res.end('ok');
		});
		setUserChannelConfig(userId, 'webhook', { url });
		const result = await webhook.test(userId);
		expect(result.ok).toBe(true);
		close();
	});
});
