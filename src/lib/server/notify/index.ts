/**
 * Five-channel fail-closed, SPV-verified notifier -- the watchtower's
 * detection side (DECISIONS.md §4.9, §4.2, M6): email / Telegram / ntfy /
 * Nostr / webhook. Hard invariant: detection failure never fires a false
 * positive (SPV-before-notify). Channel delivery is a stub until M6; the
 * `events` table (activity feed + SSE replay source) already exists
 * (migration 003) so Home's watchtower-feed skeleton has something real,
 * if empty, to read.
 */
import { getDb } from '../db/index.js';
import { publish } from '../events/index.js';
import { logWarn } from '../log.js';

export type NotifyChannel = 'email' | 'telegram' | 'ntfy' | 'nostr' | 'webhook';

export interface FeedEvent {
	id: number;
	type: string;
	level: 'info' | 'success' | 'warning' | 'danger';
	title: string;
	body: string | null;
	createdAt: string;
}

interface FeedEventRow {
	id: number;
	type: string;
	level: FeedEvent['level'];
	title: string;
	body: string | null;
	created_at: string;
}

/** Most recent activity-feed entries, newest first. Empty until M6 writes any. */
export function listRecentEvents(limit = 20): FeedEvent[] {
	const rows = getDb()
		.prepare('SELECT id, type, level, title, body, created_at FROM events ORDER BY id DESC LIMIT ?')
		.all(limit) as unknown as FeedEventRow[];
	return rows.map((r) => ({
		id: r.id,
		type: r.type,
		level: r.level,
		title: r.title,
		body: r.body,
		createdAt: r.created_at
	}));
}

export interface NotifyInput {
	type: string;
	/** null = a broadcast/admin notice (no specific user). */
	userId: number | null;
	level: 'info' | 'success' | 'warning' | 'danger';
	title: string;
	body?: string | null;
	/** Arbitrary structured context (JSON-serialized into the `detail` column). */
	detail?: unknown;
	/** Deep-link the eventual channel/UI surfaces should point at (folded into `detail`). */
	link?: string;
}

/**
 * Record a notification (M5 wires these calls; M6 owns the actual five-
 * channel delivery -- email/Telegram/ntfy/Nostr/webhook -- per DECISIONS.md
 * §4.6/MINING-ENGINE.md §3.4/§6's "M5 wires notify(), M6 owns delivery"
 * contract). For now this writes the `events` row (so the activity feed /
 * watchtower skeleton has real content) and nudges the `notification` SSE
 * topic. Never throws -- a notify failure must never break the caller (the
 * mining engine calls this from inside its own best-effort block-accepted
 * handler, invariant 4: the engine never crashes the app).
 */
export function notify(input: NotifyInput): void {
	try {
		const detail =
			input.detail !== undefined || input.link !== undefined
				? JSON.stringify({ ...(input.detail !== undefined ? { ...toRecord(input.detail) } : {}), ...(input.link !== undefined ? { link: input.link } : {}) })
				: null;
		getDb()
			.prepare(
				`INSERT INTO events (type, user_id, level, title, body, detail) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(input.type, input.userId, input.level, input.title, input.body ?? null, detail);
		// Nudge-only (DECISIONS.md §4.5): the client refetches its own gated view;
		// publish() never reads SQLite -- the row above is already written.
		if (input.userId !== null) {
			publish('notification', { kind: 'user', userId: input.userId }, {});
		} else {
			publish('notification', { kind: 'broadcast' }, {});
		}
	} catch (e) {
		logWarn('notify', { event: 'notify_failed', type: input.type, err: String(e) });
	}
}

function toRecord(v: unknown): Record<string, unknown> {
	return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
}
