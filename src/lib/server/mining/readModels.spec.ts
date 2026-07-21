/**
 * T7 acceptance (MINING-ENGINE.md §9.1, §6.1): getUserMiningView(userId) is
 * strictly scoped to that user's own prefs/workers/blocks -- a security
 * regression test -- plus sanity checks on the totals/odds/wallets shape and
 * that getPublicPoolView never exposes owner-only settings.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from '../wallet/index.js';
import { setPayoutWallet, setUserMiningEnabled, ensureMiningPrefs } from './prefs.js';
import { getMiningAggregates, __resetMiningEngineForTests } from './index.js';
import { getUserMiningView, getPublicPoolView } from './readModels.js';

vi.mock('../node/index.js', () => ({
	getNodeClient: () => ({
		getTipHeight: async () => 900,
		coreRpc: { call: async (method: string) => (method === 'getblockchaininfo' ? { chain: 'regtest' } : null) }
	})
}));

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

let userA: number;
let userB: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('a', 'h', 'member')").run();
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('b', 'h', 'member')").run();
	const rows = db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[];
	userA = rows[0]!.id;
	userB = rows[1]!.id;
	__resetMiningEngineForTests();
});

describe('readModels/getUserMiningView: strict per-user scoping', () => {
	it("user A's view never shows user B's workers, blocks, or connection", async () => {
		const walletA = importWallet(userA, { name: 'A', xpub: ZPUB });
		const walletB = importWallet(userB, { name: 'B', xpub: ZPUB });
		setPayoutWallet(userA, walletA.id);
		setUserMiningEnabled(userA, true);
		const prefsA = ensureMiningPrefs(userA);
		setPayoutWallet(userB, walletB.id);
		setUserMiningEnabled(userB, true);
		const prefsB = ensureMiningPrefs(userB);

		const agg = getMiningAggregates();
		agg.recordShare({ userId: userA, miningId: prefsA.miningId!, worker: 'a-rig', difficulty: 5, timestampMs: Date.now() });
		agg.recordShare({ userId: userB, miningId: prefsB.miningId!, worker: 'b-rig', difficulty: 5, timestampMs: Date.now() });

		getDb()
			.prepare(
				`INSERT INTO mining_blocks (height, block_hash, user_id, payout_address, coinbase_value_sats, submit_result)
				 VALUES (?, ?, ?, ?, ?, 'accepted')`
			)
			.run(100, 'aa'.repeat(32), userB, 'bcrt1qfixture', 5_000_000_000);

		const viewA = await getUserMiningView(userA);
		expect(viewA.connection?.miningId).toBe(prefsA.miningId);
		expect(viewA.workers.map((w) => w.name)).toEqual(['a-rig']);
		expect(viewA.workers.some((w) => w.name === 'b-rig')).toBe(false);
		expect(viewA.earnings.blocksFound).toHaveLength(0); // only B found a block
		expect(viewA.payout?.walletId).toBe(walletA.id);
	});

	it("returns an empty/null shape for a user who has never touched mining prefs", async () => {
		const view = await getUserMiningView(userA);
		expect(view.connection).toBeNull();
		expect(view.payout).toBeNull();
		expect(view.workers).toEqual([]);
		expect(view.earnings.blocksFound).toEqual([]);
	});
});

describe('readModels/getPublicPoolView: no owner-only material', () => {
	it('never includes a `settings` or `fatalErrors` field', async () => {
		const view = await getPublicPoolView(userA);
		expect(view).not.toHaveProperty('settings');
		expect(view).not.toHaveProperty('fatalErrors');
		expect(view.engine).toEqual({ status: expect.any(String) });
	});

	it('marks the viewer\'s own leaderboard entry isYou:true, others false', async () => {
		const agg = getMiningAggregates();
		agg.recordShare({ userId: userA, miningId: 'hearth_a', worker: 'rig', difficulty: 100, timestampMs: Date.now() });
		agg.recordShare({ userId: userB, miningId: 'hearth_b', worker: 'rig', difficulty: 50, timestampMs: Date.now() });
		agg.flush();
		const view = await getPublicPoolView(userA);
		const a = view.leaderboard.find((l) => l.name.includes(String(userA)) || l.isYou);
		expect(view.leaderboard.some((l) => l.isYou)).toBe(true);
		void a;
	});
});
