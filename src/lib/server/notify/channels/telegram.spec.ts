/**
 * T6 acceptance (WATCHTOWER.md §2.2, §6.4): Telegram's own API is not a
 * user-supplied SSRF target, so this mocks global fetch directly (unlike
 * webhook/ntfy, which prove real delivery through a local server).
 * 401/403 -> non-retryable (bad token / user never /start'ed the bot);
 * 429 -> retryable; isConfigured requires BOTH a chatId and an instance
 * bot token.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from '../config/secrets.js';
import { setUserChannelConfig, setInstanceSecret, initNotifyOrigin } from '../config/channelConfig.js';
import { telegram } from './telegram.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userId: number;
let secretDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-telegram-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initNotifyOrigin('https://hearth.example');
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

function okResponse(): Response {
	return new Response('{"ok":true}', { status: 200 });
}
function statusResponse(status: number): Response {
	return new Response('{}', { status });
}

describe('T6: Telegram channel', () => {
	it('isConfigured requires BOTH a chatId and an instance bot token', () => {
		expect(telegram.isConfigured(userId)).toBe(false);
		setUserChannelConfig(userId, 'telegram', { chatId: 12345 });
		expect(telegram.isConfigured(userId)).toBe(false); // no bot token yet
		setInstanceSecret('telegram_bot_token', 'BOT:TOKEN');
		expect(telegram.isConfigured(userId)).toBe(true);
	});

	it('POSTs HTML-formatted sendMessage to the right chat', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 999 });
		setInstanceSecret('telegram_bot_token', 'BOT:TOKEN');
		fetchMock.mockResolvedValueOnce(okResponse());

		const result = await telegram.send(userId, {
			type: 'tx_received',
			userId,
			level: 'success',
			title: 'Payment received',
			body: 'You received 0.001 BTC.',
			link: '/wallets/1'
		});
		expect(result.ok).toBe(true);
		const [calledUrl, calledOpts] = fetchMock.mock.calls[0];
		expect(String(calledUrl)).toContain('api.telegram.org/botBOT:TOKEN/sendMessage');
		const body = JSON.parse((calledOpts as RequestInit).body as string);
		expect(body.chat_id).toBe(999);
		expect(body.parse_mode).toBe('HTML');
		expect(body.text).toContain('<b>Payment received</b>');
		expect(body.text).toContain('https://hearth.example/wallets/1');
	});

	it('401/403 is non-retryable (bad token / user never /start\'ed the bot)', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 1 });
		setInstanceSecret('telegram_bot_token', 'x');
		fetchMock.mockResolvedValueOnce(statusResponse(403));
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it('429 is retryable', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 1 });
		setInstanceSecret('telegram_bot_token', 'x');
		fetchMock.mockResolvedValueOnce(statusResponse(429));
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.retryable).toBe(true);
	});

	it('5xx is retryable', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 1 });
		setInstanceSecret('telegram_bot_token', 'x');
		fetchMock.mockResolvedValueOnce(statusResponse(500));
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.retryable).toBe(true);
	});

	it('a network throw is retryable', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 1 });
		setInstanceSecret('telegram_bot_token', 'x');
		fetchMock.mockRejectedValueOnce(new Error('network down'));
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
	});

	it('no chatId configured fails non-retryable without calling fetch', async () => {
		setInstanceSecret('telegram_bot_token', 'x');
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('no instance bot token configured fails non-retryable', async () => {
		setUserChannelConfig(userId, 'telegram', { chatId: 1 });
		const result = await telegram.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});
});
