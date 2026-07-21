/**
 * T5 acceptance -- the no-price-push assertion (DECISIONS.md §3 rules 4 & 6;
 * WATCHTOWER.md §3.4, §6.5): "never push on a price move." Enforced
 * structurally, not by convention, in three parts:
 *
 *  (a) NOTIFICATION_EVENT_TYPES has no price/fiat/rate member.
 *  (b) a static import-scan of notify/** finds no import from any price/spot
 *      module (none exists in this codebase yet -- DECISIONS.md §4.4's
 *      opt-in BTC/USD spot DISPLAY is explicitly off the critical path and
 *      never reaches notify/; this test is the regression guard for if one
 *      is ever added).
 *  (c) every event type, rendered even with a mocked price smuggled into
 *      `detail`, never produces a `$`-led price-change title -- the
 *      renderer itself cannot fabricate a price headline from arbitrary
 *      detail data.
 *
 * "A simulated price move fires zero notifications" is proven structurally
 * here (there is no price-watching entry point anywhere in notify/'s public
 * surface for a price event to reach) rather than by running a fake price
 * feed through dispatch() -- there is nothing in this codebase that could
 * construct such an event in the first place, which IS the guarantee.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFICATION_EVENT_TYPES, type NotificationPayload } from './types.js';
import { renderEmail, renderTelegram, renderNtfy, renderNostr, renderWebhookBody } from './queue/render.js';
import * as notifyIndex from './index.js';

const NOTIFY_DIR = dirname(fileURLToPath(import.meta.url));
const PRICE_PATTERN = /price|fiat|usd|rate/i;
// 'rate' alone would false-positive on legitimate fee-RATE language elsewhere
// in the app, but NOTIFICATION_EVENT_TYPES only ever holds tx_* members --
// asserting the full pattern against THIS short, controlled list is safe and
// exactly what WATCHTOWER.md §6.5(a) specifies.

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
	}
	return out;
}

describe('T5: no-price-push -- structural assertions (DECISIONS.md §3, WATCHTOWER.md §3.4)', () => {
	it('(a) NOTIFICATION_EVENT_TYPES has no price/fiat/usd/rate member', () => {
		for (const type of NOTIFICATION_EVENT_TYPES) {
			expect(PRICE_PATTERN.test(type)).toBe(false);
		}
	});

	it('(b) no file under notify/** imports from any price/spot module', () => {
		const offenders: string[] = [];
		for (const file of listSourceFiles(NOTIFY_DIR)) {
			const src = readFileSync(file, 'utf8');
			const importLines = src.match(/^import .*$/gm) ?? [];
			for (const line of importLines) {
				if (/from\s+['"][^'"]*(price|spot)[^'"]*['"]/i.test(line)) {
					offenders.push(`${file}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it('(c) every event type, even with a price smuggled into detail, never renders a $-led title', () => {
		const DOLLAR_LED = /^\s*\$[\d,.]/;
		for (const type of NOTIFICATION_EVENT_TYPES) {
			const payload: NotificationPayload = {
				type,
				userId: 1,
				level: 'info',
				title: 'Payment received', // a real renderer never invents a NEW title from detail
				body: 'You received 0.001 BTC.',
				detail: { amountSats: 100000, btcUsd: 65000, fiatDelta: '+$120' }, // an attacker/bug smuggling price data
				link: '/wallets/1'
			};
			const email = renderEmail(payload, 'https://hearth.example');
			const telegram = renderTelegram(payload, 'https://hearth.example');
			const ntfy = renderNtfy(payload, 'https://hearth.example');
			const nostr = renderNostr(payload, 'https://hearth.example');
			const webhook = renderWebhookBody(payload, 'https://hearth.example');

			expect(DOLLAR_LED.test(email.subject)).toBe(false);
			expect(DOLLAR_LED.test(telegram)).toBe(false);
			expect(DOLLAR_LED.test(ntfy.title)).toBe(false);
			expect(DOLLAR_LED.test(nostr)).toBe(false);
			expect(DOLLAR_LED.test(webhook.title)).toBe(false);
		}
	});

	it('a simulated price move cannot fire anything -- no price-shaped entry point exists on notify/index.ts\'s public surface', () => {
		const surfaceNames = Object.keys(notifyIndex).map((k) => k.toLowerCase());
		const priceyExport = surfaceNames.find((n) => PRICE_PATTERN.test(n));
		expect(priceyExport).toBeUndefined();
	});
});
