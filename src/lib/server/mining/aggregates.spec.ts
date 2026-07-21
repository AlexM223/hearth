/**
 * T5 acceptance (MINING-ENGINE.md §9.1, §5): delta-upsert correctness across
 * two flushes; best_share_diff is MAX; closed-minute buckets written exactly
 * once; round_id stays NULL; window prune by age + hard cap; restart
 * preserves cumulative counters + best-share + history (not the live window).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { MiningAggregates } from './aggregates.js';
import type { ShareEvent } from './types.js';

function share(userId: number, worker: string, difficulty: number, timestampMs: number): ShareEvent {
	return { userId, miningId: `hearth_${userId}`, worker, difficulty, timestampMs };
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	// mining_workers/mining_stats.user_id are FK'd to users(id) -- the fixture
	// userIds (1, 2) used throughout this file must exist.
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('u1', 'h', 'member')").run();
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('u2', 'h', 'member')").run();
});

describe('aggregates: recordShare / liveWorkers (in-memory, no DB)', () => {
	it('accumulates cumulative counters and the running best share', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share(1, 'rig1', 2, 1000));
		agg.recordShare(share(1, 'rig1', 8, 2000));
		agg.recordShare(share(1, 'rig1', 4, 3000));
		const [w] = agg.liveWorkers(1);
		expect(w!.sharesAccepted).toBe(3);
		expect(w!.sumDifficulty).toBe(14);
		expect(w!.bestShareDiff).toBe(8);
		expect(w!.currentDiff).toBe(4); // the LAST share's difficulty
	});

	it('scopes liveWorkers to the requested user only', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share(1, 'rig1', 1, 1000));
		agg.recordShare(share(2, 'rig1', 1, 1000));
		expect(agg.liveWorkers(1)).toHaveLength(1);
		expect(agg.liveWorkers(2)).toHaveLength(1);
		expect(agg.liveAllMiners()).toHaveLength(2);
	});

	it('recordReject counts stale separately from other rejection reasons', () => {
		const agg = new MiningAggregates();
		agg.recordReject({ userId: 1, worker: 'rig1', reason: 'stale' });
		agg.recordReject({ userId: 1, worker: 'rig1', reason: 'low_difficulty' });
		agg.recordReject({ userId: 1, worker: 'rig1', reason: 'duplicate' });
		const [w] = agg.liveWorkers(1);
		expect(w!.sharesStale).toBe(1);
		expect(w!.sharesRejected).toBe(2);
	});

	it('the rolling window prunes entries older than 24h', () => {
		const agg = new MiningAggregates();
		const now = Date.now();
		agg.recordShare(share(1, 'rig1', 1, now - 25 * 3_600_000)); // 25h old — pruned
		agg.recordShare(share(1, 'rig1', 1, now)); // fresh
		expect(agg.windowSizeForTest(1, 'rig1')).toBe(1);
	});

	it('the rolling window hard-caps entries even within the age window', () => {
		const agg = new MiningAggregates();
		const now = Date.now();
		for (let i = 0; i < 5_010; i++) agg.recordShare(share(1, 'rig1', 1, now - (5010 - i)));
		expect(agg.windowSizeForTest(1, 'rig1')).toBeLessThanOrEqual(5_000);
	});
});

describe('aggregates: flush (batched persistence)', () => {
	it('delta-upsert correctness across two flushes — mining_workers accumulates, does not overwrite', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share(1, 'rig1', 2, Date.now()));
		agg.flush();
		agg.recordShare(share(1, 'rig1', 3, Date.now()));
		agg.flush();
		const row = getDb()
			.prepare('SELECT shares_accepted, sum_weight FROM mining_workers WHERE user_id = 1 AND worker_name = ?')
			.get('rig1') as { shares_accepted: number; sum_weight: number };
		expect(row.shares_accepted).toBe(2);
		expect(row.sum_weight).toBe(5);
	});

	it('best_share_diff is MAX across flushes, never regresses on a smaller later share', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share(1, 'rig1', 10, Date.now()));
		agg.flush();
		agg.recordShare(share(1, 'rig1', 3, Date.now()));
		agg.flush();
		const row = getDb()
			.prepare('SELECT best_share_diff FROM mining_workers WHERE user_id = 1 AND worker_name = ?')
			.get('rig1') as { best_share_diff: number };
		expect(row.best_share_diff).toBe(10);
	});

	it('a no-op flush (no new activity) does not re-nudge and leaves the row unchanged', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share(1, 'rig1', 1, Date.now()));
		agg.flush();
		const before = getDb().prepare('SELECT shares_accepted FROM mining_workers').get() as {
			shares_accepted: number;
		};
		agg.flush(); // nothing new
		const after = getDb().prepare('SELECT shares_accepted FROM mining_workers').get() as {
			shares_accepted: number;
		};
		expect(after.shares_accepted).toBe(before.shares_accepted);
	});

	it('writes a closed-minute bucket exactly once, with round_id NULL (the dormant seam)', () => {
		vi.useFakeTimers();
		try {
			const agg = new MiningAggregates();
			const t0 = Date.parse('2026-01-01T00:00:10.000Z');
			vi.setSystemTime(t0);
			agg.recordShare(share(1, 'rig1', 4, t0));
			agg.flush(t0); // bucket still open (< 60s elapsed) — nothing written yet
			expect(
				(getDb().prepare('SELECT COUNT(*) AS n FROM mining_stats').get() as { n: number }).n
			).toBe(0);

			const t1 = t0 + 61_000; // minute has closed
			vi.setSystemTime(t1);
			agg.flush(t1);
			const rows = getDb().prepare('SELECT * FROM mining_stats ORDER BY user_id IS NULL').all() as {
				user_id: number | null;
				worker_name: string | null;
				shares: number;
				round_id: number | null;
			}[];
			expect(rows).toHaveLength(2); // one per-worker row + one pool row
			for (const r of rows) expect(r.round_id).toBeNull();
			const workerRow = rows.find((r) => r.user_id === 1)!;
			expect(workerRow.shares).toBe(1);
			const poolRow = rows.find((r) => r.user_id === null)!;
			expect(poolRow.shares).toBe(1);

			// A second flush after the bucket is gone does not duplicate it.
			agg.flush(t1 + 1000);
			expect(
				(getDb().prepare('SELECT COUNT(*) AS n FROM mining_stats').get() as { n: number }).n
			).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never throws even if a share references pathological values', () => {
		const agg = new MiningAggregates();
		expect(() => agg.recordShare(share(1, 'rig1', Number.NaN, Date.now()))).not.toThrow();
		expect(() => agg.flush()).not.toThrow();
	});
});

describe('aggregates: restart durability', () => {
	it('a fresh MiningAggregates instance sees the flushed cumulative counters + best share via the DB (not the live window)', () => {
		const agg1 = new MiningAggregates();
		agg1.recordShare(share(1, 'rig1', 7, Date.now()));
		agg1.flush();

		// "Restart": a brand-new in-memory instance has NO live window...
		const agg2 = new MiningAggregates();
		expect(agg2.liveWorkers(1)).toHaveLength(0);
		// ...but the DB mirror (what read models fall back to for "best ever") survived.
		const row = getDb()
			.prepare('SELECT shares_accepted, best_share_diff FROM mining_workers WHERE user_id = 1')
			.get() as { shares_accepted: number; best_share_diff: number };
		expect(row.shares_accepted).toBe(1);
		expect(row.best_share_diff).toBe(7);
	});
});
