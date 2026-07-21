/**
 * Pool attribution seam test (EXPLORER.md §2, §6). M5 has now landed the real
 * `mining_blocks` table (migration 007) -- this file no longer needs the
 * ad-hoc CREATE TABLE this test used to simulate "post-M5" with; every
 * migrated test DB has the real table from here on. The "no fixture rows"
 * describe block below still exercises the genuinely-useful empty-table case
 * (a fresh instance with no blocks found yet) -- `getBlockPoolAttribution`/
 * `listPoolFoundBlockHashes` must return null/empty WITHOUT throwing. The
 * populated-table block inserts fixture rows against the REAL migrated schema
 * (payout_address/coinbase_value_sats/submit_result are NOT NULL there) and
 * asserts the correct `finderDisplayName`/`isYou` for both viewer cases.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { getBlockPoolAttribution, listPoolFoundBlockHashes } from './pool.js';

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
});

describe('chain/pool: no blocks found yet (fresh instance, empty mining_blocks)', () => {
	it('getBlockPoolAttribution returns null without throwing', () => {
		expect(() => getBlockPoolAttribution('deadbeef', null)).not.toThrow();
		expect(getBlockPoolAttribution('deadbeef', 1)).toBeNull();
	});

	it('listPoolFoundBlockHashes returns an empty Set without throwing', () => {
		expect(() => listPoolFoundBlockHashes()).not.toThrow();
		expect(listPoolFoundBlockHashes()).toEqual(new Set());
	});
});

describe('chain/pool: mining_blocks populated (real migrated schema, fixture rows)', () => {
	function setUp(): { finderId: number; otherId: number } {
		const db = getDb();
		db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)').run(
			'alex',
			'h',
			'owner',
			'Alex'
		);
		db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
			'bailey',
			'h',
			'member'
		);
		const finderId = Number(
			(db.prepare('SELECT id FROM users WHERE username = ?').get('alex') as { id: number }).id
		);
		const otherId = Number(
			(db.prepare('SELECT id FROM users WHERE username = ?').get('bailey') as { id: number }).id
		);
		db.prepare(
			`INSERT INTO mining_blocks
			   (height, block_hash, user_id, payout_address, coinbase_value_sats, submit_result, found_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(934200, 'cafebabe', finderId, 'bcrt1qfixture', 5000000000, 'accepted', '2026-07-21T00:00:00.000Z');
		return { finderId, otherId };
	}

	it('resolves finderDisplayName + isYou:true for the finder viewer', () => {
		const { finderId } = setUp();
		const attribution = getBlockPoolAttribution('cafebabe', finderId);
		expect(attribution).toEqual({
			height: 934200,
			blockHash: 'cafebabe',
			finderDisplayName: 'Alex',
			isYou: true,
			foundAt: '2026-07-21T00:00:00.000Z'
		});
	});

	it('resolves isYou:false for a different viewer, and null for an anonymous viewer', () => {
		const { otherId } = setUp();
		expect(getBlockPoolAttribution('cafebabe', otherId)?.isYou).toBe(false);
		expect(getBlockPoolAttribution('cafebabe', null)?.isYou).toBe(false);
	});

	it('listPoolFoundBlockHashes includes the accepted block hash', () => {
		setUp();
		expect(listPoolFoundBlockHashes().has('cafebabe')).toBe(true);
	});

	it('a non-"accepted" submit_result is never attributed', () => {
		const { finderId } = setUp();
		getDb()
			.prepare(
				`INSERT INTO mining_blocks
				   (height, block_hash, user_id, payout_address, coinbase_value_sats, submit_result, found_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(934201, 'stale', finderId, 'bcrt1qfixture', 5000000000, 'rejected:stale', '2026-07-21T00:00:01.000Z');
		expect(getBlockPoolAttribution('stale', finderId)).toBeNull();
		expect(listPoolFoundBlockHashes().has('stale')).toBe(false);
	});
});
