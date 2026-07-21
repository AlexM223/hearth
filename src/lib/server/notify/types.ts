/**
 * notify/ shared types (WATCHTOWER.md §0.3, §2.1, §2.7, §3.1). IMPORT-FREE of
 * anything stateful (no DB, no network, no other notify/ submodule) so the
 * five channel plugins can depend on it without a cycle.
 *
 * `DECISIONS.md` §3 rule 6 / WATCHTOWER.md §3.4: there is deliberately NO
 * price/fiat/rate event type here -- see notify/noPricePush.spec.ts, which
 * statically asserts none ever gets added.
 */

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error';

/** The `events` table's level vocabulary (migration 003) -- distinct spelling
 *  from NotificationLevel by design (warn/error vs warning/danger); mapped at
 *  write time in dispatch.ts, never elsewhere. */
export type EventsLevel = 'info' | 'success' | 'warning' | 'danger';

export function toEventsLevel(level: NotificationLevel): EventsLevel {
	if (level === 'warn') return 'warning';
	if (level === 'error') return 'danger';
	return level;
}

/**
 * The watchtower's own event types (WATCHTOWER.md §1). Deliberately narrow --
 * this is NOT a generic app-wide notification-type registry (mining/system
 * events keep using the pre-existing `notify()` in notify/index.ts, which
 * writes the `events` row directly without external-channel routing; see
 * notify/index.ts's module doc for the documented reasoning).
 */
export const NOTIFICATION_EVENT_TYPES = ['tx_received', 'tx_confirmed', 'tx_large', 'tx_replaced'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['inapp', 'email', 'telegram', 'ntfy', 'nostr', 'webhook'] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];

/** The five with a plugin + outbox delivery -- everything but 'inapp'. */
export const EXTERNAL_NOTIFICATION_CHANNELS = NOTIFICATION_CHANNELS.filter(
	(c): c is Exclude<NotificationChannelId, 'inapp'> => c !== 'inapp'
);

export interface NotificationPayload {
	type: NotificationEventType;
	/** null = an instance/admin event -- reaches every Owner. Not currently
	 *  produced by the watchtower's tx events (always user-scoped), but kept
	 *  for symmetry with the payload shape WATCHTOWER.md §3.1 documents. */
	userId: number | null;
	level: NotificationLevel;
	/** Short: "Payment received". */
	title: string;
	/** One or two plain sentences, jargon glossed, sats-first (WATCHTOWER.md §3.1). */
	body: string;
	/** Structured, NON-SECRET context (amountSats, height, confirmations,
	 *  walletName). NEVER a PSBT, xprv, token, password, or seed. */
	detail?: Record<string, unknown>;
	/** Relative deep-link, e.g. "/wallets/3". Resolved to absolute for
	 *  out-of-app channels via render.ts's absoluteNotificationLink. */
	link?: string;
}

export interface ChannelSendResult {
	ok: boolean;
	/** Shown in the "last error" UI when ok=false. */
	error?: string;
	/** true = transient (network/5xx) -> queue retries; false = config/4xx -> mark failed, stop. */
	retryable?: boolean;
}

export interface NotificationChannelPlugin {
	id: Exclude<NotificationChannelId, 'inapp'>;
	label: string; // "Email", "Telegram", ...
	send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult>;
	/** Settings "send test" -- the SAME send path. */
	test(userId: number): Promise<ChannelSendResult>;
	/** Pure DB read, no network -- greys the toggle. */
	isConfigured(userId: number): boolean;
}

/** Per-relay/per-request bound so one black-holing endpoint can never wedge
 *  the sequential single-flight outbox drain (cairn-49qw, cairn-a2b6). */
export const REQUEST_TIMEOUT_MS = 10_000;
