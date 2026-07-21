/**
 * T6 acceptance (WATCHTOWER.md §2.2, §6.4): ntfy send success through a
 * real local server (SSRF pinning), 401/403 non-retryable, isConfigured,
 * the SSRF guard applies to the SERVER url.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, setMeta } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from '../config/secrets.js';
import { setUserChannelConfig, encryptUserSecretField, initNotifyOrigin } from '../config/channelConfig.js';
import { ntfy } from './ntfy.js';
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
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-ntfy-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initNotifyOrigin('https://hearth.example');
	setMeta('webhook_allow_private_targets', '1'); // shared escape hatch, ON for these local-server tests
});

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
	const server = http.createServer(handler);
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
		});
	});
}

describe('T6: ntfy channel', () => {
	it('isConfigured reflects saved topic', () => {
		expect(ntfy.isConfigured(userId)).toBe(false);
		setUserChannelConfig(userId, 'ntfy', { topic: 'hearth-alerts' });
		expect(ntfy.isConfigured(userId)).toBe(true);
	});

	it('POSTs {topic,title,message,priority,click} to the configured server', async () => {
		let received: Record<string, unknown> | null = null;
		const { url, close } = await startServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				res.writeHead(200);
				res.end('ok');
			});
		});
		setUserChannelConfig(userId, 'ntfy', { server: url, topic: 'hearth-alerts' });

		const result = await ntfy.send(userId, {
			type: 'tx_received',
			userId,
			level: 'error',
			title: 'Payment reversed',
			body: 'A payment was reversed.',
			link: '/wallets/1'
		});
		expect(result.ok).toBe(true);
		expect(received).toMatchObject({
			topic: 'hearth-alerts',
			title: 'Payment reversed',
			message: 'A payment was reversed.',
			priority: 5,
			click: 'https://hearth.example/wallets/1'
		});
		close();
	});

	it('sends the access token as a Bearer auth header when configured', async () => {
		let authHeader: string | undefined;
		const { url, close } = await startServer((req, res) => {
			authHeader = req.headers.authorization;
			res.writeHead(200);
			res.end('ok');
		});
		setUserChannelConfig(userId, 'ntfy', {
			server: url,
			topic: 't',
			accessTokenEnc: encryptUserSecretField('tk_abc123')
		});
		await ntfy.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(authHeader).toBe('Bearer tk_abc123');
		close();
	});

	it('401/403 is non-retryable', async () => {
		const { url, close } = await startServer((_req, res) => {
			res.writeHead(403);
			res.end('forbidden');
		});
		setUserChannelConfig(userId, 'ntfy', { server: url, topic: 't' });
		const result = await ntfy.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
		close();
	});

	it('5xx is retryable', async () => {
		const { url, close } = await startServer((_req, res) => {
			res.writeHead(503);
			res.end('unavailable');
		});
		setUserChannelConfig(userId, 'ntfy', { server: url, topic: 't' });
		const result = await ntfy.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.retryable).toBe(true);
		close();
	});

	it('with no topic configured, fails non-retryable', async () => {
		const result = await ntfy.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});
});
