/**
 * T7 acceptance (WATCHTOWER.md §2.7): default routing is external-off; a
 * saved enabled=1 row only resolves to a target when the channel is ALSO
 * configured; milestones/threshold reads fall back to the documented
 * defaults.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { initSecretKey, __resetSecretKeyForTests } from './secrets.js';
import { setUserChannelConfig } from './channelConfig.js';
import { resolveExternalTargets, setPreference, getMilestonesForUser, getLargeThresholdSats, DEFAULT_MILESTONES } from './prefs.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userId: number;
let secretDir: string;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'member')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-prefs-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
});
afterEach(() => {
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

describe('T7: resolveExternalTargets (default routing)', () => {
	it('resolves NO external targets by default (external channels are opt-in)', () => {
		expect(resolveExternalTargets(userId, 'tx_received')).toEqual([]);
	});

	it('a saved enabled=1 row with a CONFIGURED channel resolves as a target', () => {
		setPreference(userId, 'tx_received', 'webhook', true);
		setUserChannelConfig(userId, 'webhook', { url: 'https://93.184.216.34/hook' });
		expect(resolveExternalTargets(userId, 'tx_received')).toEqual([{ channel: 'webhook' }]);
	});

	it('a saved enabled=1 row WITHOUT channel config never resolves (isConfigured gate)', () => {
		setPreference(userId, 'tx_received', 'webhook', true);
		// no setUserChannelConfig call -- isConfigured() is false
		expect(resolveExternalTargets(userId, 'tx_received')).toEqual([]);
	});

	it('an explicit enabled=0 row overrides a would-be-configured channel', () => {
		setUserChannelConfig(userId, 'webhook', { url: 'https://93.184.216.34/hook' });
		setPreference(userId, 'tx_received', 'webhook', false);
		expect(resolveExternalTargets(userId, 'tx_received')).toEqual([]);
	});

	it('routing is per event type -- enabling for tx_received does not enable tx_replaced', () => {
		setUserChannelConfig(userId, 'webhook', { url: 'https://93.184.216.34/hook' });
		setPreference(userId, 'tx_received', 'webhook', true);
		expect(resolveExternalTargets(userId, 'tx_received').length).toBe(1);
		expect(resolveExternalTargets(userId, 'tx_replaced').length).toBe(0);
	});
});

describe('T7: confirmation-milestone + threshold reads', () => {
	it('defaults to DEFAULT_MILESTONES ([1]) with no saved config', () => {
		expect(getMilestonesForUser(userId)).toEqual(DEFAULT_MILESTONES);
	});

	it('reads a saved [1,3,6] opt-in', () => {
		setPreference(userId, 'tx_confirmed', 'inapp', true, { confirmations: [1, 3, 6] });
		expect(getMilestonesForUser(userId)).toEqual([1, 3, 6]);
	});

	it('getLargeThresholdSats defaults to null', () => {
		expect(getLargeThresholdSats(userId)).toBeNull();
	});

	it('reads a saved threshold', () => {
		setPreference(userId, 'tx_large', 'inapp', true, { thresholdSats: 1_000_000 });
		expect(getLargeThresholdSats(userId)).toBe(1_000_000);
	});
});
