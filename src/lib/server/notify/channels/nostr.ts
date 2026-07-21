/**
 * The Nostr channel (WATCHTOWER.md §2.2, §2.4) -- DECISION: NIP-17 private
 * DMs (gift-wrapped, sealed, via nostr-tools' own nip17/nip59 helpers),
 * NEVER NIP-04 (deprecated, leaks sender/recipient/timing in cleartext
 * tags -- a watchtower DM correlating in real time with an on-chain payment
 * would hand a relay observer a financial-surveillance feed). Publish to N
 * relays (SSRF-gated via ssrf.ts's checkRelayUrl -- relays are user-supplied
 * ws(s):// targets); OK if >=1 accepts, retryable only if ALL fail.
 */
import { generateSecretKey } from 'nostr-tools/pure';
import { wrapEvent } from 'nostr-tools/nip17';
import { nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import type { NostrEvent } from 'nostr-tools/core';
import { checkRelayUrl } from './ssrf.js';
import { getUserChannelConfig, getInstanceMeta, getInstanceSecret, setInstanceSecret, getNotifyOrigin } from '../config/channelConfig.js';
import { renderNostr } from '../queue/render.js';
import type { ChannelSendResult, NotificationChannelPlugin, NotificationPayload } from '../types.js';

export const RELAY_PUBLISH_TIMEOUT_MS = 10_000;

interface NostrUserConfig {
	recipientPubkey?: string; // hex or npub
	relays?: string[];
}

function config(userId: number): NostrUserConfig | null {
	return getUserChannelConfig(userId, 'nostr') as NostrUserConfig | null;
}

/** Decodes npub1... to hex; passes a bare 64-hex-char pubkey through as-is.
 *  Fails closed (null) on anything else. */
export function decodePubkey(raw: string): string | null {
	const trimmed = raw.trim();
	if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
	if (trimmed.startsWith('npub1')) {
		try {
			const decoded = nip19.decode(trimmed);
			if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * The instance's own Nostr sender identity -- generated on first use,
 * encrypted at rest. Fails closed: a present-but-undecryptable key means
 * investigate, NEVER silently regenerate (a fresh identity would orphan
 * every prior DM's recipient trust). instance_secrets.getInstanceSecret
 * already returns null on a decrypt failure vs. a genuinely-absent key --
 * both need to be told apart here, so this reads the raw row itself.
 */
export class NostrIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NostrIdentityError';
	}
}

function defaultRelays(): string[] {
	const raw = getInstanceMeta('nostr_default_relays');
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
	} catch {
		return [];
	}
}

/** Gets (or generates, on first use) the instance's Nostr sender private key. */
export function getOrCreateSenderPrivateKey(): Uint8Array {
	const existingHex = getInstanceSecret('nostr_sender_privkey');
	if (existingHex !== null) {
		if (!/^[0-9a-f]{64}$/i.test(existingHex)) {
			throw new NostrIdentityError('stored Nostr identity is malformed -- investigate before continuing');
		}
		return hexToBytes(existingHex);
	}
	const key = generateSecretKey();
	setInstanceSecret('nostr_sender_privkey', bytesToHex(key));
	return key;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Test seam: the real implementation connects over a real WebSocket relay;
 *  tests inject a fake to avoid real network/relay dependencies. */
export type RelayPublisher = (relayUrl: string, event: NostrEvent, timeoutMs: number) => Promise<boolean>;

async function realPublishToRelay(relayUrl: string, event: NostrEvent, timeoutMs: number): Promise<boolean> {
	let relay: Relay | undefined;
	try {
		relay = await Relay.connect(relayUrl);
		await Promise.race([
			relay.publish(event),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay publish timeout')), timeoutMs))
		]);
		return true;
	} catch {
		return false;
	} finally {
		relay?.close();
	}
}

let publisher: RelayPublisher = realPublishToRelay;
export function __setRelayPublisherForTests(fn: RelayPublisher): void {
	publisher = fn;
}
export function __resetRelayPublisherForTests(): void {
	publisher = realPublishToRelay;
}

async function sendTo(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const cfg = config(userId);
	if (!cfg?.recipientPubkey) return { ok: false, retryable: false, error: 'no Nostr recipient configured' };
	const recipientHex = decodePubkey(cfg.recipientPubkey);
	if (!recipientHex) return { ok: false, retryable: false, error: 'invalid Nostr recipient pubkey' };

	const relays = cfg.relays && cfg.relays.length > 0 ? cfg.relays : defaultRelays();
	if (relays.length === 0) return { ok: false, retryable: false, error: 'no Nostr relays configured' };

	let senderKey: Uint8Array;
	try {
		senderKey = getOrCreateSenderPrivateKey();
	} catch (e) {
		return { ok: false, retryable: false, error: String(e) };
	}

	const message = renderNostr(payload, getNotifyOrigin());
	// NIP-17: gift-wrapped (kind 1059), sealed (kind 13), signed by a FRESH
	// ephemeral key with a randomized timestamp -- a relay observer sees only
	// "someone sent an encrypted gift wrap to pubkey Y," never this instance
	// as the sender, never the real time (nostr-tools handles all of this).
	const wrapped = wrapEvent(senderKey, { publicKey: recipientHex }, message) as unknown as NostrEvent;

	let anyAccepted = false;
	let anyValidTarget = false;
	for (const relayUrl of relays) {
		const check = await checkRelayUrl(relayUrl);
		if (!check.ok) continue; // SSRF-blocked relay -- skip, don't count against retryability
		anyValidTarget = true;
		const accepted = await publisher(relayUrl, wrapped, RELAY_PUBLISH_TIMEOUT_MS);
		if (accepted) anyAccepted = true;
	}

	if (!anyValidTarget) return { ok: false, retryable: false, error: 'every configured relay was SSRF-blocked' };
	if (anyAccepted) return { ok: true };
	return { ok: false, retryable: true, error: 'no relay accepted the event' };
}

export const nostr: NotificationChannelPlugin = {
	id: 'nostr',
	label: 'Nostr',
	send: sendTo,
	async test(userId) {
		// Honest copy -- Nostr has no delivery receipt (WATCHTOWER.md §2.4).
		return sendTo(userId, {
			type: 'tx_received',
			userId,
			level: 'info',
			title: 'Hearth test notification',
			body: 'This is a test notification from your Hearth watchtower (published to at least one relay).'
		});
	},
	isConfigured(userId) {
		const cfg = config(userId);
		if (!cfg?.recipientPubkey || !decodePubkey(cfg.recipientPubkey)) return false;
		const relays = cfg.relays && cfg.relays.length > 0 ? cfg.relays : defaultRelays();
		return relays.length > 0;
	}
};
