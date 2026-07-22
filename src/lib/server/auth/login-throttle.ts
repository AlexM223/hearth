/**
 * In-memory login throttle (DECISIONS.md: single-process monolith, so an
 * in-process map is correct -- no shared state across instances to worry
 * about). Fixed-window counter per key: once a key racks up MAX_ATTEMPTS
 * failures inside WINDOW_MS, further attempts for that key are rejected
 * until the window rolls over. loginWithPassword (users.ts) keys this by
 * username, and by client IP too when the login route can supply one, so
 * neither "hammer one account from anywhere" nor "spray many accounts from
 * one IP" gets unlimited free tries.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;

/** Hard cap on distinct keys tracked at once -- a flood of bogus usernames/IPs
 *  must not grow this map without bound. Crude but sufficient: once past the
 *  cap, the whole table resets (a burst of false negatives is far better than
 *  an unbounded memory leak). */
const MAX_TRACKED_KEYS = 10_000;

interface Window {
	count: number;
	windowStart: number;
}

const attempts = new Map<string, Window>();

export interface ThrottleStatus {
	blocked: boolean;
	/** Only meaningful when `blocked` is true. */
	retryAfterMs: number;
}

/** Whether `key` is currently locked out. Read-only -- does not mutate state. */
export function checkThrottle(key: string, now = Date.now()): ThrottleStatus {
	const w = attempts.get(key);
	if (!w) return { blocked: false, retryAfterMs: 0 };
	const elapsed = now - w.windowStart;
	if (elapsed >= WINDOW_MS) return { blocked: false, retryAfterMs: 0 };
	if (w.count < MAX_ATTEMPTS) return { blocked: false, retryAfterMs: 0 };
	return { blocked: true, retryAfterMs: WINDOW_MS - elapsed };
}

/** Record a failed attempt for `key`, starting a new window if the previous
 *  one (if any) has expired. */
export function recordFailure(key: string, now = Date.now()): void {
	const w = attempts.get(key);
	if (!w || now - w.windowStart >= WINDOW_MS) {
		if (!attempts.has(key) && attempts.size >= MAX_TRACKED_KEYS) attempts.clear();
		attempts.set(key, { count: 1, windowStart: now });
		return;
	}
	w.count += 1;
}

/** Clear throttle state for `key` -- called on a successful login. */
export function clearThrottle(key: string): void {
	attempts.delete(key);
}

/** Test-only: wipe all throttle state between test runs. */
export function resetLoginThrottle(): void {
	attempts.clear();
}
