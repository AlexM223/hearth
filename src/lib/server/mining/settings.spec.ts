/**
 * T0 acceptance (MINING-ENGINE.md §9.3): mining settings default off, unset
 * keys fall back to defaults, an explicit stored value always wins, and a
 * malformed stored value falls back rather than propagating NaN.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { setMeta } from '../db/meta.js';
import {
	readMiningSettings,
	writeMiningSetting,
	DEFAULT_SHARE_DIFFICULTY,
	DEFAULT_ASIC_SHARE_DIFFICULTY
} from './settings.js';

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
});

describe('mining/settings: readMiningSettings', () => {
	it('defaults to OFF (mining_enabled unset)', () => {
		expect(readMiningSettings().enabled).toBe(false);
	});

	it('defaults: loopback bind, 3333/3334 ports, vardiff on at target 6/min', () => {
		const s = readMiningSettings();
		expect(s.bind).toBe('loopback');
		expect(s.bindHost).toBe('127.0.0.1');
		expect(s.stratumPort).toBe(3333);
		expect(s.shareDifficulty).toBe(DEFAULT_SHARE_DIFFICULTY);
		expect(s.vardiffEnabled).toBe(true);
		expect(s.vardiffTargetPerMin).toBe(6);
		expect(s.asicPortEnabled).toBe(true);
		expect(s.asicStratumPort).toBe(3334);
		expect(s.asicShareDifficulty).toBe(DEFAULT_ASIC_SHARE_DIFFICULTY);
		expect(s.poolTag).toBe('Hearth');
	});

	it('SV2 seam keys are defined and default off (MINING-ENGINE.md §9.4)', () => {
		const s = readMiningSettings();
		expect(s.sv2Enabled).toBe(false);
		expect(s.sv2Port).toBe(3335);
	});

	it('an explicit saved value always wins over the default', () => {
		writeMiningSetting('mining_enabled', true);
		writeMiningSetting('mining_stratum_port', 4000);
		writeMiningSetting('mining_share_difficulty', 2);
		const s = readMiningSettings();
		expect(s.enabled).toBe(true);
		expect(s.stratumPort).toBe(4000);
		expect(s.shareDifficulty).toBe(2);
	});

	it('bind tri-state resolves to a concrete host: lan/all -> 0.0.0.0', () => {
		writeMiningSetting('mining_bind', 'lan');
		expect(readMiningSettings().bindHost).toBe('0.0.0.0');
	});

	it('a malformed stored port/difficulty falls back to the default, never NaN', () => {
		setMeta('mining_stratum_port', 'not-a-number');
		setMeta('mining_share_difficulty', 'nope');
		const s = readMiningSettings();
		expect(s.stratumPort).toBe(3333);
		expect(s.shareDifficulty).toBe(DEFAULT_SHARE_DIFFICULTY);
	});

	it('is read FRESH every call -- a write is visible on the next read with no cache', () => {
		expect(readMiningSettings().enabled).toBe(false);
		writeMiningSetting('mining_enabled', true);
		expect(readMiningSettings().enabled).toBe(true);
	});
});

describe('mining/settings: advertised (host-published) ports vs internal bind ports (hearth-ny4.1)', () => {
	const STRATUM_ENV = 'HEARTH_MINING_STRATUM_EXTERNAL_PORT';
	const ASIC_ENV = 'HEARTH_MINING_ASIC_EXTERNAL_PORT';

	afterEach(() => {
		delete process.env[STRATUM_ENV];
		delete process.env[ASIC_ENV];
	});

	it('defaults to the internal port when no external-port env var is set (bare-metal/dev has no host remap)', () => {
		const s = readMiningSettings();
		expect(s.advertisedStratumPort).toBe(s.stratumPort);
		expect(s.advertisedAsicStratumPort).toBe(s.asicStratumPort);
	});

	it('uses the env-supplied external port when set (the Umbrel compose host-port remap, e.g. 3343/3344)', () => {
		process.env[STRATUM_ENV] = '3343';
		process.env[ASIC_ENV] = '3344';
		const s = readMiningSettings();
		expect(s.advertisedStratumPort).toBe(3343);
		expect(s.advertisedAsicStratumPort).toBe(3344);
		// The internal bind port is UNCHANGED by the external-port env var.
		expect(s.stratumPort).toBe(3333);
		expect(s.asicStratumPort).toBe(3334);
	});

	it('falls back to the internal port on a malformed external-port env var', () => {
		process.env[STRATUM_ENV] = 'not-a-number';
		expect(readMiningSettings().advertisedStratumPort).toBe(readMiningSettings().stratumPort);
	});
});
