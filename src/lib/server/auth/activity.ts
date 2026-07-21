/**
 * Throttled `users.last_active_at` touch (COME-ABOARD.md §3.2, §4's "Owner
 * sees a liveness bucket, never an exact timestamp" -- the write here is the
 * raw timestamp; the coarsening into "active recently/this week/dormant"
 * happens at read time in the members roll-up, T10). Called from the session
 * guard on every authenticated request, so it's throttled in-memory to avoid
 * a synchronous SQLite write on every single request.
 */
import { getDb } from '../db/index.js';

const THROTTLE_MS = 60_000;
const lastTouch = new Map<number, number>();

/** Update last_active_at for `userId`, at most once per THROTTLE_MS. */
export function touchLastActive(userId: number, now = Date.now()): void {
	const prev = lastTouch.get(userId);
	if (prev !== undefined && now - prev < THROTTLE_MS) return;
	lastTouch.set(userId, now);
	getDb().prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
}

/** Test-only: clear the in-memory throttle map between test runs. */
export function resetActivityThrottle(): void {
	lastTouch.clear();
}
