/**
 * Per-user quiet hours (WATCHTOWER.md §5.4): "A routine send may be deferred
 * to a quiet-window's end; urgent (warn/error) alerts bypass. Ship the
 * mechanism, default the window off." `queue/outbox.ts` already implements
 * the DEFERRAL mechanism behind an injected `QuietHours` interface (isQuiet/
 * resumesAtMs) -- this module is the missing other half: the real, persisted
 * per-user window (T7) and the production adapter that `notify/index.ts`'s
 * `startNotificationQueueWorker()` wires in.
 *
 * Storage reuses the `meta` kv table under a per-user-namespaced key
 * (`notify.quietHours.<userId>`), the same idiom `auth/self.ts` uses for
 * `prefs.theme.<userId>` -- no new migration needed. A window is a plain
 * local HH:MM pair (the box's own local time, not per-user timezone --
 * Hearth is a single self-hosted appliance, not a multi-region service, so a
 * single household clock is the honest simplification). Absent = quiet hours
 * off (the default), matching "ship the mechanism, default off."
 */
import { getMeta, setMeta, deleteMeta } from '../../db/index.js';
import type { QuietHours } from '../queue/outbox.js';

export interface QuietHoursWindow {
	/** Local 24h "HH:MM", e.g. "22:00". */
	start: string;
	/** Local 24h "HH:MM", e.g. "07:00". May be earlier than `start` -- that's
	 *  the normal overnight case (wraps past midnight). */
	end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm: string): number {
	const m = HHMM.exec(hhmm);
	if (!m) return NaN;
	return Number(m[1]) * 60 + Number(m[2]);
}

/** A window is valid iff both ends parse as HH:MM and they're not equal (an
 *  equal start/end is degenerate -- either "always quiet" or "never quiet"
 *  depending on how you'd read it, so it's rejected rather than guessed). */
export function isValidQuietHoursWindow(w: QuietHoursWindow): boolean {
	const s = toMinutes(w.start);
	const e = toMinutes(w.end);
	return !Number.isNaN(s) && !Number.isNaN(e) && s !== e;
}

/** Whether `date` (read in local time) falls inside `window`, handling the
 *  overnight wrap (e.g. 22:00-07:00) as well as a same-day window (e.g.
 *  09:00-17:00, used for "only notify during waking hours" framing). */
export function isWithinQuietHoursWindow(window: QuietHoursWindow, date: Date): boolean {
	const startMin = toMinutes(window.start);
	const endMin = toMinutes(window.end);
	if (Number.isNaN(startMin) || Number.isNaN(endMin) || startMin === endMin) return false;
	const nowMin = date.getHours() * 60 + date.getMinutes();
	if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
	return nowMin >= startMin || nowMin < endMin; // wraps midnight
}

/** The next local Date (>= now) at which `window` closes -- today's close if
 *  it hasn't happened yet, otherwise tomorrow's. Used so a deferred send's
 *  `next_attempt_at` lands exactly at the window's end, not an arbitrary
 *  guess. */
export function quietHoursResumeDate(window: QuietHoursWindow, now: Date): Date {
	const endMin = toMinutes(window.end);
	const endHour = Math.floor(endMin / 60);
	const endMinute = endMin % 60;
	const result = new Date(now);
	result.setHours(endHour, endMinute, 0, 0);
	if (result.getTime() <= now.getTime()) result.setDate(result.getDate() + 1);
	return result;
}

function metaKey(userId: number): string {
	return `notify.quietHours.${userId}`;
}

/** The user's saved quiet-hours window, or null if never set / off (the
 *  default). A malformed stored value (should never happen -- only
 *  `setQuietHoursWindow` writes it -- but fails closed like every other
 *  parse in this codebase) is treated as "off" rather than thrown. */
export function getQuietHoursWindow(userId: number): QuietHoursWindow | null {
	const raw = getMeta(metaKey(userId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<QuietHoursWindow>;
		if (typeof parsed.start === 'string' && typeof parsed.end === 'string' && isValidQuietHoursWindow(parsed as QuietHoursWindow)) {
			return { start: parsed.start, end: parsed.end };
		}
	} catch {
		// fall through to "off"
	}
	return null;
}

/** Sets (or, with `null`, clears -- back to the default "off") the user's
 *  quiet-hours window. Throws on an invalid window so a bad form submission
 *  never silently no-ops. */
export function setQuietHoursWindow(userId: number, window: QuietHoursWindow | null): void {
	if (window === null) {
		deleteMeta(metaKey(userId));
		return;
	}
	if (!isValidQuietHoursWindow(window)) {
		throw new Error('quiet hours window must be two distinct HH:MM times');
	}
	setMeta(metaKey(userId), JSON.stringify(window));
}

/** The real `QuietHours` dependency (`queue/outbox.ts`'s injected interface)
 *  backed by the persisted per-user window above -- what
 *  `notify/index.ts`'s `startNotificationQueueWorker()` wires into the
 *  production outbox drain worker. A user with no saved window is never
 *  quiet (matches the outbox's own `NEVER_QUIET` default). */
export function createQuietHours(): QuietHours {
	return {
		isQuiet(userId, nowMs) {
			const window = getQuietHoursWindow(userId);
			if (!window) return false;
			return isWithinQuietHoursWindow(window, new Date(nowMs));
		},
		resumesAtMs(userId, nowMs) {
			const window = getQuietHoursWindow(userId);
			if (!window) return nowMs;
			return quietHoursResumeDate(window, new Date(nowMs)).getTime();
		}
	};
}
