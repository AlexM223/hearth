/**
 * T7 acceptance (WATCHTOWER.md §5.4): the persisted per-user quiet-hours
 * window + its `QuietHours` production adapter -- default OFF, an overnight
 * (midnight-wrapping) window resolved correctly, and the resume time landing
 * exactly at the window's close.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import {
	getQuietHoursWindow,
	setQuietHoursWindow,
	isValidQuietHoursWindow,
	isWithinQuietHoursWindow,
	quietHoursResumeDate,
	createQuietHours
} from './quietHours.js';

let userId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

describe('T7: quiet hours -- default OFF, persisted round-trip', () => {
	it('defaults to null (off) with nothing saved', () => {
		expect(getQuietHoursWindow(userId)).toBeNull();
	});

	it('round-trips a saved overnight window', () => {
		setQuietHoursWindow(userId, { start: '22:00', end: '07:00' });
		expect(getQuietHoursWindow(userId)).toEqual({ start: '22:00', end: '07:00' });
	});

	it('clearing with null returns to off', () => {
		setQuietHoursWindow(userId, { start: '22:00', end: '07:00' });
		setQuietHoursWindow(userId, null);
		expect(getQuietHoursWindow(userId)).toBeNull();
	});

	it('rejects a degenerate window (equal start/end) rather than silently accepting it', () => {
		expect(() => setQuietHoursWindow(userId, { start: '09:00', end: '09:00' })).toThrow();
		expect(isValidQuietHoursWindow({ start: '09:00', end: '09:00' })).toBe(false);
	});

	it('rejects a malformed HH:MM', () => {
		expect(() => setQuietHoursWindow(userId, { start: '25:00', end: '07:00' })).toThrow();
	});
});

describe('T7: isWithinQuietHoursWindow -- overnight wrap and same-day windows', () => {
	const overnight = { start: '22:00', end: '07:00' };
	const daytime = { start: '09:00', end: '17:00' };

	it('overnight window: 23:30 is quiet, 10:00 is not', () => {
		expect(isWithinQuietHoursWindow(overnight, new Date(2026, 0, 1, 23, 30))).toBe(true);
		expect(isWithinQuietHoursWindow(overnight, new Date(2026, 0, 1, 10, 0))).toBe(false);
	});

	it('overnight window: 02:00 (past midnight, before end) is quiet', () => {
		expect(isWithinQuietHoursWindow(overnight, new Date(2026, 0, 1, 2, 0))).toBe(true);
	});

	it('overnight window: exactly the end minute is NOT quiet (half-open interval)', () => {
		expect(isWithinQuietHoursWindow(overnight, new Date(2026, 0, 1, 7, 0))).toBe(false);
	});

	it('same-day window: 12:00 is quiet, 20:00 is not', () => {
		expect(isWithinQuietHoursWindow(daytime, new Date(2026, 0, 1, 12, 0))).toBe(true);
		expect(isWithinQuietHoursWindow(daytime, new Date(2026, 0, 1, 20, 0))).toBe(false);
	});
});

describe('T7: quietHoursResumeDate -- resumes exactly at the window close', () => {
	it('currently inside an overnight window after midnight -> resumes later TODAY', () => {
		const now = new Date(2026, 0, 2, 2, 0); // Jan 2, 02:00
		const resume = quietHoursResumeDate({ start: '22:00', end: '07:00' }, now);
		expect(resume.getDate()).toBe(2);
		expect(resume.getHours()).toBe(7);
		expect(resume.getMinutes()).toBe(0);
	});

	it('currently inside an overnight window before midnight -> resumes TOMORROW', () => {
		const now = new Date(2026, 0, 1, 23, 30); // Jan 1, 23:30
		const resume = quietHoursResumeDate({ start: '22:00', end: '07:00' }, now);
		expect(resume.getDate()).toBe(2);
		expect(resume.getHours()).toBe(7);
	});
});

describe('T7: createQuietHours() -- the QuietHours dep wired into the real outbox worker', () => {
	it('a user with no saved window is never quiet', () => {
		const qh = createQuietHours();
		const now = new Date(2026, 0, 1, 23, 30).getTime();
		expect(qh.isQuiet(userId, now)).toBe(false);
	});

	it('a saved overnight window makes isQuiet true at night, false in the day, and resumesAtMs matches the close', () => {
		setQuietHoursWindow(userId, { start: '22:00', end: '07:00' });
		const qh = createQuietHours();
		const night = new Date(2026, 0, 1, 23, 0).getTime();
		const day = new Date(2026, 0, 1, 12, 0).getTime();
		expect(qh.isQuiet(userId, night)).toBe(true);
		expect(qh.isQuiet(userId, day)).toBe(false);
		const resumed = new Date(qh.resumesAtMs(userId, night));
		expect(resumed.getHours()).toBe(7);
	});
});
