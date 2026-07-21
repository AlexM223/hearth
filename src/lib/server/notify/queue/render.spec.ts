/**
 * T5 acceptance (WATCHTOWER.md §3.3): every event type renders in every
 * channel form; a relative link resolves to absolute against HEARTH_ORIGIN;
 * ntfy priority mapping; Telegram HTML escaping.
 */
import { describe, expect, it } from 'vitest';
import type { NotificationPayload } from '../types.js';
import { NOTIFICATION_EVENT_TYPES } from '../types.js';
import {
	absoluteNotificationLink,
	renderEmail,
	renderTelegram,
	renderNtfy,
	renderNostr,
	renderWebhookBody
} from './render.js';

const ORIGIN = 'https://hearth.example';

function payloadFor(type: (typeof NOTIFICATION_EVENT_TYPES)[number]): NotificationPayload {
	return {
		type,
		userId: 1,
		level: 'success',
		title: 'Payment received',
		body: 'You received 0.0015 BTC in Savings.',
		detail: { amountSats: 150000 },
		link: '/wallets/3'
	};
}

describe('T5: absoluteNotificationLink', () => {
	it('resolves a relative link against the origin', () => {
		expect(absoluteNotificationLink('/wallets/3', ORIGIN)).toBe('https://hearth.example/wallets/3');
	});
	it('passes an already-absolute link through unchanged', () => {
		expect(absoluteNotificationLink('https://elsewhere.example/x', ORIGIN)).toBe('https://elsewhere.example/x');
	});
	it('falls back to the relative link when no origin is configured', () => {
		expect(absoluteNotificationLink('/wallets/3', null)).toBe('/wallets/3');
	});
	it('returns undefined for an absent link', () => {
		expect(absoluteNotificationLink(undefined, ORIGIN)).toBeUndefined();
	});
	it('handles an origin with a trailing slash', () => {
		expect(absoluteNotificationLink('/wallets/3', 'https://hearth.example/')).toBe('https://hearth.example/wallets/3');
	});
});

describe('T5: every event type renders in every channel form', () => {
	for (const type of NOTIFICATION_EVENT_TYPES) {
		it(`${type} renders in email/telegram/ntfy/nostr/webhook without throwing`, () => {
			const payload = payloadFor(type);
			expect(() => renderEmail(payload, ORIGIN)).not.toThrow();
			expect(() => renderTelegram(payload, ORIGIN)).not.toThrow();
			expect(() => renderNtfy(payload, ORIGIN)).not.toThrow();
			expect(() => renderNostr(payload, ORIGIN)).not.toThrow();
			expect(() => renderWebhookBody(payload, ORIGIN)).not.toThrow();
		});
	}
});

describe('T5: per-channel formatting details', () => {
	it('email: subject is the title normally, generic when PGP is on', () => {
		const payload = payloadFor('tx_received');
		expect(renderEmail(payload, ORIGIN).subject).toBe('Payment received');
		expect(renderEmail(payload, ORIGIN, true).subject).toBe('Hearth notification');
		expect(renderEmail(payload, ORIGIN, true).html).toContain('Payment received'); // body still real
	});

	it('telegram: bold title + escaped HTML-sensitive chars', () => {
		const payload = payloadFor('tx_received');
		payload.title = 'A & B < C > D';
		const rendered = renderTelegram(payload, ORIGIN);
		expect(rendered).toContain('<b>A &amp; B &lt; C &gt; D</b>');
		expect(rendered).toContain('https://hearth.example/wallets/3');
	});

	it('ntfy priority: error=5, warn=4, else=3', () => {
		expect(renderNtfy({ ...payloadFor('tx_replaced'), level: 'error' }, ORIGIN).priority).toBe(5);
		expect(renderNtfy({ ...payloadFor('tx_replaced'), level: 'warn' }, ORIGIN).priority).toBe(4);
		expect(renderNtfy({ ...payloadFor('tx_received'), level: 'info' }, ORIGIN).priority).toBe(3);
		expect(renderNtfy({ ...payloadFor('tx_received'), level: 'success' }, ORIGIN).priority).toBe(3);
	});

	it('ntfy: click is the absolute link', () => {
		expect(renderNtfy(payloadFor('tx_received'), ORIGIN).click).toBe('https://hearth.example/wallets/3');
	});

	it('nostr: plaintext title\\n\\nbody\\n\\nabsoluteLink', () => {
		const rendered = renderNostr(payloadFor('tx_received'), ORIGIN);
		expect(rendered).toBe('Payment received\n\nYou received 0.0015 BTC in Savings.\n\nhttps://hearth.example/wallets/3');
	});

	it('webhook: stable JSON shape with both link and linkAbsolute', () => {
		const body = renderWebhookBody(payloadFor('tx_received'), ORIGIN);
		expect(body.link).toBe('/wallets/3');
		expect(body.linkAbsolute).toBe('https://hearth.example/wallets/3');
		expect(body.detail).toEqual({ amountSats: 150000 });
		expect(typeof body.timestamp).toBe('string');
	});

	it('a tx_replaced payload with NO link/detail renders webhook body without those keys', () => {
		const body = renderWebhookBody({ type: 'tx_replaced', userId: 1, level: 'warn', title: 't', body: 'b' }, ORIGIN);
		expect('link' in body).toBe(false);
		expect('linkAbsolute' in body).toBe(false);
		expect('detail' in body).toBe(false);
	});
});
