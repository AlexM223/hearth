/**
 * T7 acceptance (WATCHTOWER.md §2.6): POST /api/me/notifications/channels/
 * :channel/test is self-scoped (any authed role, own config only), rejects
 * an unknown channel, and calls the REAL channel plugin's test() -- proven
 * by mocking email's transporter factory and asserting a real `sendMail`
 * call happens (the "enqueue/send proof" -- nothing here is faked at the
 * route layer, only the outbound network transport is mocked, exactly as
 * WATCHTOWER.md §6.4 does for the channel adapter tests themselves).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { setMeta } from '$lib/server/db/index.js';
import { setUserChannelConfig } from '$lib/server/notify/config/channelConfig.js';
import { __setTransporterFactoryForTests, __resetTransporterFactoryForTests } from '$lib/server/notify/channels/email.js';
import { POST } from './+server.js';

let memberId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('mum', 'x', 'member')`).run();
	memberId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});
afterEach(() => {
	__resetTransporterFactoryForTests();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'member' | 'guest' | null, channel: string): any {
	return {
		locals: { user: role == null ? null : { id: memberId, username: 'mum', role, mustResetPassword: false } },
		params: { channel }
	};
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		if (res instanceof Response) {
			expect(res.status).toBe(status);
			return await res.json();
		}
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		const err = e as { status?: number };
		expect(err.status).toBe(status);
		return undefined;
	}
}

describe('T7: POST /api/me/notifications/channels/:channel/test -- gating', () => {
	it('an anonymous caller is rejected (401)', async () => {
		await expectStatus(() => POST(evt(null, 'webhook')), 401);
	});

	it('an unknown channel is rejected (400)', async () => {
		await expectStatus(() => POST(evt('member', 'carrier-pigeon')), 400);
	});

	it("'inapp' is rejected -- it is not a plugin, has no test() to call", async () => {
		await expectStatus(() => POST(evt('member', 'inapp')), 400);
	});

	it('a Guest may also test THEIR OWN channel (self-scoped, least privilege)', async () => {
		const body = (await expectStatus(() => POST(evt('guest', 'webhook')), 200)) as { ok: boolean };
		expect(body.ok).toBe(false); // no webhook configured for this user -- but the call is ALLOWED
	});
});

describe('T7: POST .../test -- surfaces the verbatim ChannelSendResult', () => {
	it('an unconfigured channel returns the real non-retryable "not configured" error, not a generic failure', async () => {
		const body = (await expectStatus(() => POST(evt('member', 'webhook')), 200)) as {
			ok: boolean;
			retryable?: boolean;
			error?: string;
		};
		expect(body.ok).toBe(false);
		expect(body.retryable).toBe(false);
		expect(body.error).toMatch(/no webhook URL configured/);
	});

	it('a configured channel test() runs the REAL send path -- proven via a mocked transporter, never a real SMTP connection', async () => {
		setMeta('smtp_host', 'smtp.example.com');
		setMeta('smtp_port', '587');
		setMeta('smtp_user', 'hearth@example.com');
		setMeta('smtp_from', 'hearth@example.com');
		setUserChannelConfig(memberId, 'email', { address: 'mum@example.com' });

		let sentTo: string | undefined;
		__setTransporterFactoryForTests(() => ({
			sendMail: async (opts) => {
				sentTo = opts.to;
				return { ok: true };
			}
		}));

		const body = (await expectStatus(() => POST(evt('member', 'email')), 200)) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(sentTo).toBe('mum@example.com');
	});
});
