/**
 * T12 acceptance: POST /api/settings/household is owner-only and actually
 * flips the guest.seeHouseholdBalance + household name settings.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { guestSeesHouseholdBalance, getHouseholdNameSetting } from '$lib/server/auth/index.js';
import { POST } from './+server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'owner' | 'member' | null, body?: unknown): any {
	return {
		locals: { user: role == null ? null : { id: 1, username: role, role, mustResetPassword: false } },
		request: { json: async () => body }
	};
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		if (res instanceof Response) {
			expect(res.status).toBe(status);
			return await res.json();
		}
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		const err = e as { status?: number };
		expect(err.status).toBe(status);
	}
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
});

describe('T12: POST /api/settings/household', () => {
	it('owner can set the household name and flip the guest balance opt-in', async () => {
		await expectStatus(
			() => POST(evt('owner', { householdName: 'The Martinez House', guestSeesHouseholdBalance: true })),
			200
		);
		expect(getHouseholdNameSetting()).toBe('The Martinez House');
		expect(guestSeesHouseholdBalance()).toBe(true);
	});

	it('member is denied', async () => {
		await expectStatus(() => POST(evt('member', { guestSeesHouseholdBalance: true })), 403);
	});

	it('anon is denied', async () => {
		await expectStatus(() => POST(evt(null, {})), 401);
	});

	// Audit P2#8 (hearth-276): householdName was stored unbounded -- a
	// runaway/garbage value could bloat storage and blow out the greeting
	// layout it's shown in on every page.
	describe('P2#8: householdName length cap', () => {
		it('a name over 120 chars is rejected with 400 and NOT persisted', async () => {
			const before = getHouseholdNameSetting();
			await expectStatus(() => POST(evt('owner', { householdName: 'x'.repeat(121) })), 400);
			expect(getHouseholdNameSetting()).toBe(before);
		});

		it('a name at exactly the 120-char boundary is accepted', async () => {
			const name = 'x'.repeat(120);
			await expectStatus(() => POST(evt('owner', { householdName: name })), 200);
			expect(getHouseholdNameSetting()).toBe(name);
		});
	});
});
