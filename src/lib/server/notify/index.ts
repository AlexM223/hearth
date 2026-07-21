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
