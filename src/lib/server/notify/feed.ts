/**
 * The activity feed -- the `events` table as a role-scoped READ (WATCHTOWER.md
 * §4.2, obeying COME-ABOARD.md §3.5's SSE scope map applied to the persisted
 * history). A financial event always carries a non-null `user_id`; a
 * broadcast/system event carries `user_id = NULL`. `NOTIFICATION_EVENT_TYPES`
 * is the single source for "financial" -- defense-in-depth alongside the
 * user_id split (nothing in this codebase writes a financial event with
 * user_id=null, but the type check holds even if that ever changed).
 */
import { getDb } from '../db/index.js';
import { NOTIFICATION_EVENT_TYPES, type EventsLevel } from './types.js';

export type FeedRole = 'owner' | 'member' | 'guest';

export interface FeedRow {
	id: number;
	type: string;
	userId: number | null;
	level: EventsLevel;
	title: string;
	body: string | null;
	detail: Record<string, unknown> | null;
	createdAt: string;
}

interface RawEventRow {
	id: number;
	type: string;
	user_id: number | null;
	level: EventsLevel;
	title: string;
	body: string | null;
	detail: string | null;
	created_at: string;
}

function toFeedRow(r: RawEventRow): FeedRow {
	let detail: Record<string, unknown> | null = null;
	if (r.detail) {
		try {
			detail = JSON.parse(r.detail);
		} catch {
			detail = null;
		}
	}
	return {
		id: r.id,
		type: r.type,
		userId: r.user_id,
		level: r.level,
		title: r.title,
		body: r.body,
		detail,
		createdAt: r.created_at
	};
}

const FINANCIAL_TYPES: readonly string[] = NOTIFICATION_EVENT_TYPES;
const NOT_IN_FINANCIAL = FINANCIAL_TYPES.map(() => '?').join(', ');

const COLUMNS = 'id, type, user_id, level, title, body, detail, created_at';

/**
 * Per-role feed query (WATCHTOWER.md §4.2):
 *  - owner: every row (the household feed, read-only cross-member view).
 *  - member: own rows OR a non-financial broadcast/system row.
 *  - guest: non-financial broadcast/system rows only (a Guest holds no wallet).
 */
export function listFeed(role: FeedRole, userId: number, limit = 50): FeedRow[] {
	const db = getDb();
	if (role === 'owner') {
		const rows = db
			.prepare(`SELECT ${COLUMNS} FROM events ORDER BY id DESC LIMIT ?`)
			.all(limit) as unknown as RawEventRow[];
		return rows.map(toFeedRow);
	}
	if (role === 'member') {
		const rows = db
			.prepare(
				`SELECT ${COLUMNS} FROM events
				 WHERE user_id = ? OR (user_id IS NULL AND type NOT IN (${NOT_IN_FINANCIAL}))
				 ORDER BY id DESC LIMIT ?`
			)
			.all(userId, ...FINANCIAL_TYPES, limit) as unknown as RawEventRow[];
		return rows.map(toFeedRow);
	}
	// guest
	const rows = db
		.prepare(
			`SELECT ${COLUMNS} FROM events
			 WHERE user_id IS NULL AND type NOT IN (${NOT_IN_FINANCIAL})
			 ORDER BY id DESC LIMIT ?`
		)
		.all(...FINANCIAL_TYPES, limit) as unknown as RawEventRow[];
	return rows.map(toFeedRow);
}
