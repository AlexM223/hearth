/**
 * dispatch() -- THE one entry point for the watchtower's own tx events
 * (WATCHTOWER.md §0.3 "dispatch.ts: notify(payload)"; named `dispatch` here,
 * not `notify`, because notify/index.ts already exports a `notify()` used
 * by M5's mining module for simple system/broadcast events -- see that
 * file's doc comment. A documented deviation, not a second notifier: this
 * IS the watchtower's implementation of the spec's "one entry point" idea).
 *
 * Writes the in-app `events` row + enqueues external-channel targets in ONE
 * transaction (WATCHTOWER.md §1.5, cairn-fzqpe: a crash between them must
 * never silently lose a notification), then -- best-effort, strictly AFTER
 * commit -- publishes the SSE nudge(s). The events row is written FIRST, so
 * publish() never reads SQLite (DECISIONS.md §4.5's hard invariant). Never
 * throws.
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/index.js';
import { publish } from '../events/index.js';
import { logWarn } from '../log.js';
import { toEventsLevel, type NotificationPayload, type NotificationEventType, type NotificationChannelId } from './types.js';

export interface ExternalTarget {
	channel: Exclude<NotificationChannelId, 'inapp'>;
}

export interface DispatchOptions {
	/**
	 * Resolves which external channels this user wants for this event type
	 * (T7 wires the real per-user `notification_preferences` read + each
	 * plugin's `isConfigured` gate). Default: none -- correctly matches
	 * WATCHTOWER.md §2.7's DEFAULT_PREFERENCES ("every event type defaults to
	 * ['inapp'] only; external channels are opt-in") since `inapp` is not an
	 * "external target" at all -- it's the direct `events` write above,
	 * always on.
	 */
	resolveTargets?(userId: number, eventType: NotificationEventType): ExternalTarget[];
}

function buildDetailJson(payload: NotificationPayload): string | null {
	if (payload.detail === undefined && payload.link === undefined) return null;
	return JSON.stringify({
		...(payload.detail ?? {}),
		...(payload.link !== undefined ? { link: payload.link } : {})
	});
}

/**
 * The write-only core: the `events` row + external-queue enqueue, with NO
 * transaction management of its own and NO publish. Exists so callers that
 * ALREADY hold an open transaction (detect/watcher.ts's `fireReceived`,
 * detect/confirm.ts's milestone/replaced firers -- cairn-fzqpe: the ledger
 * claim and the in-app record must be the SAME transaction) can write
 * through this exact code path instead of nesting a second `withTransaction`
 * (node:sqlite has no notion of nested transactions). `dispatch()` below is
 * the standalone convenience wrapper for every other caller.
 */
export function dispatchInTransaction(
	db: DatabaseSync,
	payload: NotificationPayload,
	opts: DispatchOptions = {}
): void {
	const eventsLevel = toEventsLevel(payload.level);
	const detailJson = buildDetailJson(payload);

	db.prepare(`INSERT INTO events (type, user_id, level, title, body, detail) VALUES (?, ?, ?, ?, ?, ?)`).run(
		payload.type,
		payload.userId,
		eventsLevel,
		payload.title,
		payload.body,
		detailJson
	);

	const targets = payload.userId != null ? (opts.resolveTargets?.(payload.userId, payload.type) ?? []) : [];
	if (targets.length > 0) {
		// Serialized payload carries NO secrets -- credentials are looked up
		// fresh inside each plugin.send() at drain time (WATCHTOWER.md §5.1).
		const serialized = JSON.stringify(payload);
		const insQueue = db.prepare(
			`INSERT INTO notification_queue (user_id, channel, event_type, payload) VALUES (?, ?, ?, ?)`
		);
		for (const t of targets) insQueue.run(payload.userId, t.channel, payload.type, serialized);
	}
}

/**
 * Best-effort, AFTER commit only (DECISIONS.md §4.5: publish() never reads
 * SQLite -- there is nothing left to read here, the row is already
 * committed by the time this runs). Exported separately so
 * dispatchInTransaction's callers can publish at the correct point (after
 * THEIR OWN transaction commits), not before.
 */
export function publishDispatched(payload: NotificationPayload): void {
	if (payload.userId !== null) {
		publish('notification', { kind: 'user', userId: payload.userId }, {});
		// The household roll-up MUST be {admin}, never {broadcast} (WATCHTOWER.md
		// §4.3) -- a broadcast of "member X received money" would leak one
		// member's activity to every other member and to Guests.
		publish('notification', { kind: 'admin' }, {});
	} else {
		publish('notification', { kind: 'broadcast' }, {});
	}
}

/** The standalone convenience wrapper: opens its OWN transaction. Never
 *  throws. Do NOT call this from inside another withTransaction callback --
 *  use dispatchInTransaction + publishDispatched instead (see above). */
export function dispatch(payload: NotificationPayload, opts: DispatchOptions = {}): void {
	try {
		withTransaction((db) => dispatchInTransaction(db, payload, opts));
		publishDispatched(payload);
	} catch (e) {
		logWarn('notify', { event: 'dispatch_failed', type: payload.type, err: String(e) });
	}
}
