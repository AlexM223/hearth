/**
 * Per-channel message rendering (WATCHTOWER.md §3.3) -- ONE renderer per
 * channel shape, all built from the SAME NotificationPayload. The
 * human-rationale rule (DECISIONS.md §3 rule 6) is enforced at the payload
 * level (notify/wiring.ts builds sats-first bodies); this module's job is
 * ONLY to reformat that already-correct payload per transport, plus resolve
 * a relative `link` to an absolute URL for anything leaving the app.
 */
import type { NotificationPayload } from '../types.js';

/**
 * A relative link (e.g. "/wallets/3") is inert outside the app -- resolve it
 * against HEARTH_ORIGIN. An already-absolute link passes through unchanged;
 * no origin configured (dev without HEARTH_ORIGIN) falls back to returning
 * the relative link as-is (best effort) rather than throwing.
 */
export function absoluteNotificationLink(link: string | undefined, origin: string | null): string | undefined {
	if (!link) return undefined;
	if (/^https?:\/\//i.test(link)) return link;
	if (!origin) return link;
	const base = origin.replace(/\/+$/, '');
	const path = link.startsWith('/') ? link : `/${link}`;
	return `${base}${path}`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** `pgpOn`: a generic subject line when the user has a PGP key on file
 *  (WATCHTOWER.md §2.2) -- the encrypted body still carries the real title. */
export function renderEmail(payload: NotificationPayload, origin: string | null, pgpOn = false): RenderedEmail {
	const absLink = absoluteNotificationLink(payload.link, origin);
	const subject = pgpOn ? 'Hearth notification' : payload.title;
	const text = absLink ? `${payload.title}\n\n${payload.body}\n\n${absLink}` : `${payload.title}\n\n${payload.body}`;
	const html =
		`<p><strong>${escapeHtml(payload.title)}</strong></p><p>${escapeHtml(payload.body)}</p>` +
		(absLink ? `<p><a href="${escapeHtml(absLink)}">${escapeHtml(absLink)}</a></p>` : '');
	return { subject, html, text };
}

/** `<b>title</b>\nbody\nlink` -- the three HTML-sensitive chars escaped. */
export function renderTelegram(payload: NotificationPayload, origin: string | null): string {
	const absLink = absoluteNotificationLink(payload.link, origin);
	const title = escapeHtml(payload.title);
	const body = escapeHtml(payload.body);
	return absLink ? `<b>${title}</b>\n${body}\n${absLink}` : `<b>${title}</b>\n${body}`;
}

export interface RenderedNtfy {
	title: string;
	message: string;
	click?: string;
	priority: number;
}

/** priority: error=5, warn=4, else=3 (WATCHTOWER.md §2.2). */
export function renderNtfy(payload: NotificationPayload, origin: string | null): RenderedNtfy {
	const priority = payload.level === 'error' ? 5 : payload.level === 'warn' ? 4 : 3;
	const click = absoluteNotificationLink(payload.link, origin);
	return click !== undefined ? { title: payload.title, message: payload.body, click, priority } : { title: payload.title, message: payload.body, priority };
}

/** plaintext `title\n\nbody\n\nabsoluteLink` (WATCHTOWER.md §3.3). */
export function renderNostr(payload: NotificationPayload, origin: string | null): string {
	const absLink = absoluteNotificationLink(payload.link, origin);
	return absLink ? `${payload.title}\n\n${payload.body}\n\n${absLink}` : `${payload.title}\n\n${payload.body}`;
}

export interface RenderedWebhookBody {
	type: string;
	level: string;
	title: string;
	body: string;
	detail?: Record<string, unknown>;
	link?: string;
	linkAbsolute?: string;
	timestamp: string;
}

/** The stable JSON shape webhook.ts (T6) signs and sends verbatim. `link`
 *  stays relative (for consumers that resolve it themselves); `linkAbsolute`
 *  is provided alongside for convenience. */
export function renderWebhookBody(payload: NotificationPayload, origin: string | null): RenderedWebhookBody {
	const linkAbsolute = absoluteNotificationLink(payload.link, origin);
	return {
		type: payload.type,
		level: payload.level,
		title: payload.title,
		body: payload.body,
		...(payload.detail !== undefined ? { detail: payload.detail } : {}),
		...(payload.link !== undefined ? { link: payload.link } : {}),
		...(linkAbsolute !== undefined ? { linkAbsolute } : {}),
		timestamp: new Date().toISOString()
	};
}
