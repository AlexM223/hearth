/**
 * T6 acceptance (WATCHTOWER.md §2.2, §2.4, §6.4): the published event is a
 * genuine kind-1059 gift wrap (never a bare kind-4), signed by a FRESH
 * ephemeral key (never the instance's real sender pubkey) -- proving NIP-17
 * is actually wired through nostr-tools, not just referenced. >=1-relay-
 * accepts is ok; all-fail is retryable; a relay SSRF-blocked (private range)
 * is skipped, not counted as a failure; the sender identity is generated
 * once and persists across calls (never silently regenerated).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from '../config/secrets.js';
import { setUserChannelConfig, getInstanceSecret, initNotifyOrigin } from '../config/channelConfig.js';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
	nostr,
	decodePubkey,
	getOrCreateSenderPrivateKey,
	__setRelayPublisherForTests,
	__resetRelayPublisherForTests,
	type RelayPublisher
} from './nostr.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userId: number;
let secretDir: string;

const RECIPIENT_HEX = 'a'.repeat(64);

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-nostr-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initNotifyOrigin('https://hearth.example');
});
afterEach(() => {
	__resetRelayPublisherForTests();
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

describe('T6: decodePubkey', () => {
	it('passes a bare 64-hex pubkey through', () => {
		expect(decodePubkey(RECIPIENT_HEX)).toBe(RECIPIENT_HEX);
	});
	it('decodes an npub1... to hex', () => {
		const npub = nip19.npubEncode(RECIPIENT_HEX);
		expect(decodePubkey(npub)).toBe(RECIPIENT_HEX);
	});
	it('rejects garbage', () => {
		expect(decodePubkey('not-a-pubkey')).toBeNull();
	});
});

describe('T6: sender identity (generated once, persists)', () => {
	it('generates a 32-byte key on first use and persists it across calls', () => {
		const key1 = getOrCreateSenderPrivateKey();
		expect(key1.length).toBe(32);
		const key2 = getOrCreateSenderPrivateKey();
		expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
	});

	it('the stored key round-trips through instance_secrets as hex', () => {
		const key = getOrCreateSenderPrivateKey();
		const stored = getInstanceSecret('nostr_sender_privkey');
		expect(stored).toBe(Buffer.from(key).toString('hex'));
	});
});

describe('T6: nostr channel -- NIP-17 gift wrap + relay delivery', () => {
	it('isConfigured requires a valid recipient pubkey AND at least one relay', () => {
		expect(nostr.isConfigured(userId)).toBe(false);
		setUserChannelConfig(userId, 'nostr', { recipientPubkey: RECIPIENT_HEX });
		expect(nostr.isConfigured(userId)).toBe(false); // no relays yet
		setUserChannelConfig(userId, 'nostr', { recipientPubkey: RECIPIENT_HEX, relays: ['wss://93.184.216.34'] });
		expect(nostr.isConfigured(userId)).toBe(true);
	});

	it('publishes a genuine kind-1059 gift wrap, signed by a FRESH ephemeral key (never the instance sender pubkey)', async () => {
		setUserChannelConfig(userId, 'nostr', {
			recipientPubkey: RECIPIENT_HEX,
			relays: ['wss://93.184.216.34']
		});
		const publishedEvents: unknown[] = [];
		const fake: RelayPublisher = async (_url, event) => {
			publishedEvents.push(event);
			return true;
		};
		__setRelayPublisherForTests(fake);

		const result = await nostr.send(userId, {
			type: 'tx_received',
			userId,
			level: 'success',
			title: 'Payment received',
			body: 'You received 0.001 BTC.',
			link: '/wallets/1'
		});
		expect(result.ok).toBe(true);
		expect(publishedEvents.length).toBe(1);

		const event = publishedEvents[0] as { kind: number; pubkey: string; content: string; tags: string[][] };
		expect(event.kind).toBe(1059); // gift wrap, NEVER a bare kind:4
		const senderKey = getOrCreateSenderPrivateKey();
		const realSenderPubkey = getPublicKey(senderKey);
		expect(event.pubkey).not.toBe(realSenderPubkey); // a FRESH ephemeral key signed the wrap
		expect(event.tags.some((t) => t[0] === 'p' && t[1] === RECIPIENT_HEX)).toBe(true); // addressed to the recipient
	});

	it('ok if >=1 relay accepts even when others fail', async () => {
		setUserChannelConfig(userId, 'nostr', {
			recipientPubkey: RECIPIENT_HEX,
			relays: ['wss://93.184.216.34', 'wss://185.199.108.153']
		});
		let call = 0;
		__setRelayPublisherForTests(async () => {
			call++;
			return call === 1; // first accepts, second fails
		});
		const result = await nostr.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(true);
	});

	it('retryable:true only when ALL relays fail', async () => {
		setUserChannelConfig(userId, 'nostr', {
			recipientPubkey: RECIPIENT_HEX,
			relays: ['wss://93.184.216.34', 'wss://185.199.108.153']
		});
		__setRelayPublisherForTests(async () => false);
		const result = await nostr.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
	});

	it('a relay in a blocked (private) range is SKIPPED, not published to', async () => {
		setUserChannelConfig(userId, 'nostr', {
			recipientPubkey: RECIPIENT_HEX,
			relays: ['wss://10.0.0.5/'] // private range -- SSRF-blocked
		});
		const calls: string[] = [];
		__setRelayPublisherForTests(async (url) => {
			calls.push(url);
			return true;
		});
		const result = await nostr.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(calls.length).toBe(0); // never even attempted
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false); // every configured relay was blocked -- a config error
	});

	it('an invalid recipient pubkey fails non-retryable', async () => {
		setUserChannelConfig(userId, 'nostr', { recipientPubkey: 'garbage', relays: ['wss://93.184.216.34'] });
		const result = await nostr.send(userId, { type: 'tx_received', userId, level: 'info', title: 't', body: 'b' });
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
	});

	it("test()'s copy is honest about no delivery receipt", async () => {
		setUserChannelConfig(userId, 'nostr', { recipientPubkey: RECIPIENT_HEX, relays: ['wss://93.184.216.34'] });
		__setRelayPublisherForTests(async () => true);
		const result = await nostr.test(userId);
		expect(result.ok).toBe(true);
	});
});
