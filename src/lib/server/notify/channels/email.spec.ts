/**
 * T6 acceptance (WATCHTOWER.md §2.2, §6.4): email send success via an
 * injected fake transporter (no real SMTP connection needed), auth/host
 * errors non-retryable, everything else retryable, isConfigured requires
 * both a destination address AND a resolvable SMTP relay (instance or
 * personal override).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, setMeta } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from '../config/secrets.js';
import { setUserChannelConfig, setInstanceSecret, initNotifyOrigin } from '../config/channelConfig.js';
import { email, __setTransporterFactoryForTests, __resetTransporterFactoryForTests, type EmailTransporter } from './email.js';
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
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-email-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initNotifyOrigin('https://hearth.example');
	setMeta('smtp_host', 'smtp.example.com');
	setMeta('smtp_port', '587');
	setMeta('smtp_user', 'hearth@example.com');
	setMeta('smtp_from', 'hearth@example.com');
	setInstanceSecret('smtp_pass', 'relay-password');
});
afterEach(() => {
	__resetTransporterFactoryForTests();
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

describe('T6: email channel', () => {
	it('isConfigured requires a destination address AND a resolvable SMTP relay', () => {
		expect(email.isConfigured(userId)).toBe(false);
		setUserChannelConfig(userId, 'email', { address: 'alex@example.com' });
		expect(email.isConfigured(userId)).toBe(true); // instance SMTP resolves
	});

	it('sends via the transporter with the rendered subject/html/text', async () => {
		const sent: Record<string, unknown>[] = [];
		__setTransporterFactoryForTests(
			(opts): EmailTransporter => ({
				async sendMail(mail) {
					sent.push({ opts, mail });
					return { messageId: 'x' };
				}
			})
		);
		setUserChannelConfig(userId, 'email', { address: 'alex@example.com' });

		const result = await email.send(userId, {
			type: 'tx_received',
			userId,
			level: 'success',
			title: 'Payment received',
			body: 'You received 0.001 BTC.',
			link: '/wallets/1'
		});
		expect(result.ok).toBe(true);
		expect(sent.length).toBe(1);
		const { opts, mail } = sent[0] as { opts: Record<string, unknown>; mail: Record<string, unknown> };
		expect(opts.host).toBe('smtp.example.com');
		expect(opts.auth).toMatchObject({ user: 'hearth@example.com', pass: 'relay-password' });
		expect(mail.to).toBe('alex@example.com');
		expect(mail.subject).toBe('Payment received');
		expect(mail.html).toContain('Payment received');
	});

	it('an auth/host error is non-retryable', async () => {
		__setTransporterFactoryForTests((): EmailTransporter => ({
			async sendMail() {
				throw new Error('Invalid login: 535 Authentication failed');
			}
		}));
		setUserChannelConfig(userId, 'email', { address: 'alex@example.com' });
		const result = await email.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it('a timeout/connection error is retryable', async () => {
		__setTransporterFactoryForTests((): EmailTransporter => ({
			async sendMail() {
				throw new Error('Connection timeout');
			}
		}));
		setUserChannelConfig(userId, 'email', { address: 'alex@example.com' });
		const result = await email.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
	});

	it('no destination address configured fails non-retryable', async () => {
		const result = await email.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it('a personal SMTP override takes precedence over the instance relay', async () => {
		const sent: Record<string, unknown>[] = [];
		__setTransporterFactoryForTests((opts): EmailTransporter => ({
			async sendMail(mail) {
				sent.push({ opts, mail });
				return {};
			}
		}));
		setUserChannelConfig(userId, 'email', {
			address: 'alex@example.com',
			smtp: { host: 'personal.smtp.example.com', port: 465, user: 'alex', tls: 'tls' }
		});
		await email.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		const { opts } = sent[0] as { opts: Record<string, unknown> };
		expect(opts.host).toBe('personal.smtp.example.com');
		expect(opts.secure).toBe(true);
	});
});
