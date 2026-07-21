/**
 * The outbox queue: `notification_queue` repo + the drain worker
 * (WATCHTOWER.md §5). Durable (survives a restart -- `pending`/`failed` rows
 * resume), retry-with-backoff, per-channel rate-limited, single-flight,
 * urgent-first priority, batchable digest coalescing, optional quiet hours.
 * The worker never throws -- a tick failure logs and the loop lives.
 */
import { getDb } from '../../db/index.js';
import { logWarn } from '../../log.js';
import type { NotificationChannelId, NotificationChannelPlugin, NotificationPayload, ChannelSendResult } from '../types.js';

export const TICK_MS = 5_000;
export const BATCH_LIMIT = 20;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000] as const;
export const RATE_PER_SEC = 5;
export const BUCKET_SIZE = 5;

/** Types eligible for burst-coalescing into one digest send (WATCHTOWER.md
 *  §5.3). Webhook is excluded -- automation consumers want one JSON object
 *  per event, never a collapsed digest. */
const BATCHABLE_TYPES = new Set(['tx_received', 'tx_confirmed']);

export type ExternalChannelId = Exclude<NotificationChannelId, 'inapp'>;

export interface QueueRow {
	id: number;
	userId: number;
	channel: ExternalChannelId;
	eventType: string;
	payload: NotificationPayload;
	status: 'pending' | 'sent' | 'failed' | 'dead';
	attempts: number;
	nextAttemptAt: string; // ISO
	lastError: string | null;
	sentAt: string | null;
}

interface RawQueueRow {
	id: number;
	user_id: number;
	channel: string;
	event_type: string;
	payload: string;
	status: string;
	attempts: number;
	next_attempt_at: string;
	last_error: string | null;
	sent_at: string | null;
}

function toRow(r: RawQueueRow): QueueRow {
	let payload: NotificationPayload;
	try {
		payload = JSON.parse(r.payload);
	} catch {
		payload = { type: 'tx_received', userId: r.user_id, level: 'info', title: '', body: '' };
	}
	return {
		id: r.id,
		userId: r.user_id,
		channel: r.channel as ExternalChannelId,
		eventType: r.event_type,
		payload,
		status: r.status as QueueRow['status'],
		attempts: r.attempts,
		nextAttemptAt: r.next_attempt_at,
		lastError: r.last_error,
		sentAt: r.sent_at
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

export function selectDueRows(nowMs: number = Date.now(), limit: number = BATCH_LIMIT): QueueRow[] {
	const rows = getDb()
		.prepare(
			`SELECT id, user_id, channel, event_type, payload, status, attempts, next_attempt_at, last_error, sent_at
			 FROM notification_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?`
		)
		.all(new Date(nowMs).toISOString(), limit) as unknown as RawQueueRow[];
	return rows.map(toRow);
}

/** error/warn ahead of routine; ties FIFO (stable sort preserves the SQL's
 *  `ORDER BY id ASC`). An urgent alert never waits behind a routine burst. */
export function priorityOrder(rows: QueueRow[]): QueueRow[] {
	const urgency = (r: QueueRow): number => (r.payload.level === 'error' || r.payload.level === 'warn' ? 0 : 1);
	return [...rows].sort((a, b) => urgency(a) - urgency(b));
}

function markSent(id: number): void {
	getDb().prepare(`UPDATE notification_queue SET status = 'sent', sent_at = ? WHERE id = ?`).run(nowIso(), id);
}
function markFailed(id: number, error: string | undefined): void {
	getDb()
		.prepare(`UPDATE notification_queue SET status = 'failed', last_error = ? WHERE id = ?`)
		.run(error ?? null, id);
}
function markRetry(id: number, attempts: number, error: string | undefined): void {
	if (attempts >= MAX_ATTEMPTS) {
		getDb()
			.prepare(`UPDATE notification_queue SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?`)
			.run(attempts, error ?? null, id);
		return;
	}
	const delayMs = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
	const next = new Date(Date.now() + delayMs).toISOString();
	getDb()
		.prepare(`UPDATE notification_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
		.run(attempts, next, error ?? null, id);
}
/** A quiet-hours deferral is NOT a failed attempt -- `attempts` unchanged. */
function deferForQuietHours(id: number, resumeAtMs: number): void {
	getDb()
		.prepare(`UPDATE notification_queue SET next_attempt_at = ? WHERE id = ?`)
		.run(new Date(resumeAtMs).toISOString(), id);
}
/** A digest send only needs to update sent/failed rows the SAME way, in bulk
 *  (used when N rows collapse into one plugin.send call). */
function markManySent(ids: number[]): void {
	if (ids.length === 0) return;
	const db = getDb();
	const stmt = db.prepare(`UPDATE notification_queue SET status = 'sent', sent_at = ? WHERE id = ?`);
	const ts = nowIso();
	for (const id of ids) stmt.run(ts, id);
}

// ------------------------------------------------------------- rate limiter

interface TokenBucket {
	tokens: number;
	lastRefillMs: number;
}

/** In-memory per-channel token bucket. Resets to full on a restart --
 *  harmless (WATCHTOWER.md §5.1). */
export function createRateLimiter(): Map<ExternalChannelId, TokenBucket> {
	return new Map();
}

/** Attempts to take one token for `channel`; false = rate-limited (row stays
 *  pending, retried next tick, no attempts increment). */
export function takeToken(
	buckets: Map<ExternalChannelId, TokenBucket>,
	channel: ExternalChannelId,
	nowMs: number = Date.now(),
	capacity: number = BUCKET_SIZE,
	ratePerSec: number = RATE_PER_SEC
): boolean {
	let bucket = buckets.get(channel);
	if (!bucket) {
		bucket = { tokens: capacity, lastRefillMs: nowMs };
		buckets.set(channel, bucket);
	}
	const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
	bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * ratePerSec);
	bucket.lastRefillMs = nowMs;
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
}

// ------------------------------------------------------------------ digests

/** Groups DUE, rate-limit-passing rows that share (user,channel,event_type)
 *  for a BATCHABLE type into one digest group (webhook excluded, a group of
 *  one is not a burst). Returns [digestGroups, individualRows]. */
function groupForDigest(rows: QueueRow[]): { groups: QueueRow[][]; singles: QueueRow[] } {
	const byKey = new Map<string, QueueRow[]>();
	const singles: QueueRow[] = [];
	for (const row of rows) {
		if (row.channel === 'webhook' || !BATCHABLE_TYPES.has(row.eventType)) {
			singles.push(row);
			continue;
		}
		const key = `${row.userId}:${row.channel}:${row.eventType}`;
		const list = byKey.get(key) ?? [];
		list.push(row);
		byKey.set(key, list);
	}
	const groups: QueueRow[][] = [];
	for (const list of byKey.values()) {
		if (list.length > 1) groups.push(list);
		else singles.push(...list);
	}
	return { groups, singles };
}

function digestPayload(rows: QueueRow[]): NotificationPayload {
	const first = rows[0].payload;
	return {
		type: first.type,
		userId: first.userId,
		level: first.level,
		title: `${rows.length} updates`,
		body: `${rows.length} ${first.type === 'tx_received' ? 'payments received' : 'confirmations'}.`,
		detail: { count: rows.length }
	};
}

// --------------------------------------------------------------- the worker

export interface QuietHours {
	isQuiet(userId: number, nowMs: number): boolean;
	resumesAtMs(userId: number, nowMs: number): number;
}

const NEVER_QUIET: QuietHours = {
	isQuiet: () => false,
	resumesAtMs: (_u, nowMs) => nowMs
};

export interface OutboxDeps {
	channels: Partial<Record<ExternalChannelId, NotificationChannelPlugin>>;
	quietHours?: QuietHours;
	rateLimiter?: Map<ExternalChannelId, TokenBucket>;
	now?: () => number;
}

async function sendOne(deps: OutboxDeps, row: QueueRow): Promise<ChannelSendResult> {
	const plugin = deps.channels[row.channel];
	if (!plugin) {
		return { ok: false, retryable: false, error: `no plugin registered for channel ${row.channel}` };
	}
	try {
		return await plugin.send(row.userId, row.payload);
	} catch (e) {
		// A throwing plugin is a coding bug in one channel -- treat as
		// retryable transient so it can never wedge the queue permanently
		// (cairn-49qw/-a2b6's spirit: isolate one channel's failure).
		return { ok: false, retryable: true, error: String(e) };
	}
}

function applyResult(row: QueueRow, result: ChannelSendResult): void {
	if (result.ok) {
		markSent(row.id);
		return;
	}
	if (result.retryable === false) {
		markFailed(row.id, result.error);
		return;
	}
	markRetry(row.id, row.attempts + 1, result.error);
}

/** One tick of the drain worker (WATCHTOWER.md §5.2). Never throws. */
export async function tick(deps: OutboxDeps): Promise<void> {
	try {
		const now = deps.now?.() ?? Date.now();
		const buckets = deps.rateLimiter ?? createRateLimiter();
		const quietHours = deps.quietHours ?? NEVER_QUIET;

		const due = priorityOrder(selectDueRows(now, BATCH_LIMIT));
		const eligible: QueueRow[] = [];
		for (const row of due) {
			const urgent = row.payload.level === 'error' || row.payload.level === 'warn';
			if (!urgent && quietHours.isQuiet(row.userId, now)) {
				deferForQuietHours(row.id, quietHours.resumesAtMs(row.userId, now));
				continue;
			}
			if (!takeToken(buckets, row.channel, now)) {
				continue; // rate-limited -- stays pending, retried next tick
			}
			eligible.push(row);
		}

		const { groups, singles } = groupForDigest(eligible);

		for (const group of groups) {
			const payload = digestPayload(group);
			const plugin = deps.channels[group[0].channel];
			let result: ChannelSendResult;
			if (!plugin) {
				result = { ok: false, retryable: false, error: `no plugin registered for channel ${group[0].channel}` };
			} else {
				try {
					result = await plugin.send(group[0].userId, payload);
				} catch (e) {
					result = { ok: false, retryable: true, error: String(e) };
				}
			}
			if (result.ok) {
				markManySent(group.map((r) => r.id));
			} else {
				for (const row of group) applyResult(row, result);
			}
		}

		for (const row of singles) {
			const result = await sendOne(deps, row);
			applyResult(row, result);
		}
	} catch (e) {
		logWarn('notify', { event: 'outbox_tick_threw', err: String(e) });
	}
}

export interface OutboxWorker {
	stop(): void;
	/** Test/diagnostic hook: run one tick on demand. */
	tickOnce(): Promise<void>;
}

/** Starts the drain worker on a TICK_MS interval, single-flight (ticks never
 *  overlap), unref'd so it never holds the process open. Idempotent per call
 *  -- callers (hooks.server.ts, T8) are responsible for calling this once. */
export function startOutboxWorker(deps: OutboxDeps): OutboxWorker {
	let running = false;
	let stopped = false;

	async function runTick(): Promise<void> {
		if (running || stopped) return;
		running = true;
		try {
			await tick(deps);
		} finally {
			running = false;
		}
	}

	const timer = setInterval(() => void runTick(), TICK_MS);
	timer.unref?.();

	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
		tickOnce: runTick
	};
}
