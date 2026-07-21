/**
 * Pool attribution seam test (EXPLORER.md §2, §6). Run against a migrated
 * (through 006, no `mining_blocks` yet) test DB for the real pre-M5 state --
 * `getBlockPoolAttribution`/`listPoolFoundBlockHashes` must return
 * null/empty WITHOUT throwing. A second variant creates the table ad-hoc
 * (simulating post-M5) with a fixture row and asserts the correct
 * `finderDisplayName`/`isYou` for both viewer cases.
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

describe('chain/pool: pre-M5 (no mining_blocks table)', () => {
	it('getBlockPoolAttribution returns null without throwing', () => {
		expect(() => getBlockPoolAttribution('deadbeef', null)).not.toThrow();
		expect(getBlockPoolAttribution('deadbeef', 1)).toBeNull();
	});

	it('listPoolFoundBlockHashes returns an empty Set without throwing', () => {
		expect(() => listPoolFoundBlockHashes()).not.toThrow();
		expect(listPoolFoundBlockHashes()).toEqual(new Set());
	});
});

describe('chain/pool: post-M5 (mining_blocks table present, ad-hoc fixture)', () => {
	function setUp(): { finderId: number; otherId: number } {
		const db = getDb();
		db.exec(`
			CREATE TABLE mining_blocks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				height INTEGER NOT NULL,
				block_hash TEXT NOT NULL UNIQUE,
				user_id INTEGER NOT NULL REFERENCES users(id),
				submit_result TEXT NOT NULL,
				found_at TEXT NOT NULL
			);
		`);
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
			'INSERT INTO mining_blocks (height, block_hash, user_id, submit_result, found_at) VALUES (?, ?, ?, ?, ?)'
		).run(934200, 'cafebabe', finderId, 'accepted', '2026-07-21T00:00:00.000Z');
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
				'INSERT INTO mining_blocks (height, block_hash, user_id, submit_result, found_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(934201, 'stale', finderId, 'stale', '2026-07-21T00:00:01.000Z');
		expect(getBlockPoolAttribution('stale', finderId)).toBeNull();
		expect(listPoolFoundBlockHashes().has('stale')).toBe(false);
	});
});
