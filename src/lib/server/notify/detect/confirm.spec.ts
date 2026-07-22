/**
 * T2 acceptance (WATCHTOWER.md §6.2): confirmation milestones ([1] default,
 * [1,3,6] opt-in) and reorg reconciliation (reconcileDisappeared). Drives
 * the real handleNewBlock against a fake Electrum rail + a real
 * DifficultyFloor warmed with the real block-700000 vector (spvGate's own
 * proof machinery, reused here end to end).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb, withTransaction } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { importWallet, syncWallet, deriveAddresses } from '../../wallet/index.js';
import type { Wallet } from '../../wallet/index.js';
import { createDifficultyFloor, type DifficultyFloor } from './difficulty.js';
import { claimReceived, trackPendingInbound, getLedgerRow } from './ledger.js';
import {
	handleNewBlock,
	DEFAULT_MILESTONES,
	REORG_RECHECK_DEPTH,
	type ConfirmElectrumRail,
	type ConfirmHooks,
	type MilestoneEvent,
	type ReplacedEvent
} from './confirm.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const V = {
	height: 700000,
	txid: 'ed25927576988e38e4cc8e4b19d1272c480f113fb605271b190df05aa983714e',
	headerHex:
		'04e0ff3feb36c62f0471cee034811019e43b14f459b50e00cea30a000000000000000000659cecf4a06ed500031b741384e87d40ce5c16c3ec8c09b09ffe4b863c218d1f282d3c61e4480f17d767c2ab',
	pos: 1,
	merkle: [
		'1d8149eb8d8475b98113b5011cf70e0b7a4dccff71286d28b8b4b641f94f1e46',
		'cb650c493b26ebd670efca2ae84b7b235f92ee0f6daf1cd7ea7a93a9b917f51c',
		'a2b2ffb66a04e8a8709331a94bd623a1bb05b50cf52015408530ed43158ec81c',
		'dc028685d2aeda316f9061aecbf878fef89def44419520004b28ab1e6ff6fb1e',
		'988629e0a61f25615b91c8e4d1a12d1e0ce138725871d8fb6d0df3b20b808d77',
		'912f6f9fb9869c6dded8f36b618d4c643e7e5fef71543dc85b5ee9a93e0d191a',
		'2bb950e819c228449121bb7645a974c343d595444844bf564d8da3a8ff928a7f',
		'c7aff03f86413b875883a6a973c6406b22717a7f4caf3afc80cd2b91e5a65db1',
		'bad3fc4c8d071cec73c6a7878559e74df4bdd357d93224a0b094bbbb981b876a',
		'ccdff982359d3bfc1334493acad8f1dcb0fd0209c97d27b8b3927b497c178308',
		'53d1e6d928e6ff27e4c2000ae2613515e9087a423c4a446bfb5ac4a13cb5eaf7'
	]
};

let userId: number;
let wallet: Wallet;

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'owner')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
	await syncWallet(
		{
			electrum: {
				async batchRequest(items) {
					return items.map((it) => (it.method === 'blockchain.scripthash.get_history' ? [] : { confirmed: 0, unconfirmed: 0 }));
				},
				async listUnspent() {
					return [];
				},
				async getTransaction(txid: string) {
					return { txid, vin: [], vout: [] };
				}
			},
			tipHeight: V.height
		},
		wallet.id,
		{ forceRefresh: true }
	);
});

function floorAtTip(): DifficultyFloor {
	const floor = createDifficultyFloor();
	floor.acceptHeader(V.height, V.headerHex);
	return floor;
}

function fakeRail(overrides: Partial<ConfirmElectrumRail> = {}): ConfirmElectrumRail {
	return {
		async getHistory() {
			return [];
		},
		async getMerkleProof() {
			return { merkle: V.merkle, pos: V.pos };
		},
		async getBlockHeader() {
			return V.headerHex;
		},
		async getTx() {
			return { confirmations: 1 };
		},
		...overrides
	};
}

describe('T2: confirmation milestones (WATCHTOWER.md §1.6)', () => {
	it('a notified row with the DEFAULT milestone set ([1], already satisfied by claimReceived) never re-fires', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const milestoneEvents: MilestoneEvent[] = [];
		const hooks: ConfirmHooks = { afterMilestone: (e) => milestoneEvents.push(e) };
		const rail = fakeRail({
			async getTx() {
				return { confirmations: 6 }; // deep confirmations, but no milestone beyond [1] is configured
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(1);
	});

	it('an opted-in [1,3,6] user progresses through 3-conf then 6-conf, each firing exactly once', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const milestoneEvents: MilestoneEvent[] = [];
		const hooks: ConfirmHooks = {
			milestonesForUser: () => [1, 3, 6],
			afterMilestone: (e) => milestoneEvents.push(e)
		};

		// Block N: only 2 confirmations -- not enough for milestone 3 yet.
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 2 }; } }), floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(0);

		// Block N+1: 3 confirmations -- crosses milestone 3.
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 3 }; } }), floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(1);
		expect(milestoneEvents[0].milestone).toBe(3);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(3);

		// Re-processing the SAME 3-conf state must not re-fire milestone 3.
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 3 }; } }), floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(1);

		// Block N+3: 6 confirmations -- crosses milestone 6.
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 6 }; } }), floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(2);
		expect(milestoneEvents[1].milestone).toBe(6);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(6);

		// No further milestone beyond 6 is configured -- stays put forever.
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 100 }; } }), floorAtTip(), true, hooks);
		expect(milestoneEvents.length).toBe(2);
	});

	it('a milestone re-fire re-verifies SPV -- an unverifiable header at that height defers, never fires blind', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const milestoneEvents: MilestoneEvent[] = [];
		const hooks: ConfirmHooks = { milestonesForUser: () => [1, 3], afterMilestone: (e) => milestoneEvents.push(e) };
		const coldFloor = createDifficultyFloor(); // NOT warmed -- cold cache
		await handleNewBlock(
			fakeRail({ async getTx() { return { confirmations: 3 }; } }),
			coldFloor,
			true,
			hooks
		);
		expect(milestoneEvents.length).toBe(0); // deferred, not fired blind
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(1); // unchanged
	});

	it('does nothing while baselineComplete=false (startup warmup)', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const milestoneEvents: MilestoneEvent[] = [];
		await handleNewBlock(
			fakeRail({ async getTx() { return { confirmations: 6 }; } }),
			floorAtTip(),
			false,
			{ milestonesForUser: () => [1, 3, 6], afterMilestone: (e) => milestoneEvents.push(e) }
		);
		expect(milestoneEvents.length).toBe(0);
	});

	// Regression (audit-verified, cairn-fzqpe): onMilestone used to run inside
	// a try/catch that swallowed a hook failure, so markMilestone's claim
	// committed even though the in-app notification write never happened --
	// permanently losing the milestone alert with no retry.
	it('a throwing onMilestone hook rolls back markMilestone too -- lastMilestone unchanged, retries and fires on the next block', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		let hookCalls = 0;
		const hooks: ConfirmHooks = {
			milestonesForUser: () => [1, 3],
			onMilestone: () => {
				hookCalls++;
				throw new Error('simulated hook write failure mid-INSERT');
			}
		};
		await handleNewBlock(fakeRail({ async getTx() { return { confirmations: 3 }; } }), floorAtTip(), true, hooks);
		expect(hookCalls).toBe(1);
		// markMilestone must NOT have been committed alongside the failed hook
		// write -- lastMilestone stays at 1, never silently advanced to 3 with
		// nothing ever recorded.
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(1);

		// The next block (healthy hook) retries and fires successfully.
		const milestoneEvents: MilestoneEvent[] = [];
		await handleNewBlock(
			fakeRail({ async getTx() { return { confirmations: 3 }; } }),
			floorAtTip(),
			true,
			{ milestonesForUser: () => [1, 3], afterMilestone: (e) => milestoneEvents.push(e) }
		);
		expect(milestoneEvents.length).toBe(1);
		expect(milestoneEvents[0].milestone).toBe(3);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.lastMilestone).toBe(3);
	});

	it('never throws even when every rail call rejects', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		trackPendingInbound(wallet.id, userId, 'deadbeef', 1);
		const rail: ConfirmElectrumRail = {
			getHistory: () => Promise.reject(new Error('x')),
			getMerkleProof: () => Promise.reject(new Error('x')),
			getBlockHeader: () => Promise.reject(new Error('x')),
			getTx: () => Promise.reject(new Error('x'))
		};
		await expect(
			handleNewBlock(rail, floorAtTip(), true, { milestonesForUser: () => [1, 3, 6] })
		).resolves.toBeUndefined();
	});
});

describe('T2: reorg reconciliation (WATCHTOWER.md §1.6.1)', () => {
	it('a confirmed+notified tx that vanishes from EVERY watched history fires tx_replaced (was confirmed)', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('No such mempool or blockchain transaction');
			},
			async getHistory() {
				return []; // genuinely gone from every address's history
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });

		expect(replacedEvents.length).toBe(1);
		expect(replacedEvents[0].wasConfirmed).toBe(true);
		expect(replacedEvents[0].silent).toBe(false);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('replaced');

		// The original row is APPENDED to, never deleted -- still readable.
		expect(getLedgerRow(wallet.id, userId, V.txid)).not.toBeNull();
	});

	it('a PENDING (never-confirmed) tx that vanishes fires tx_replaced with wasConfirmed=false', async () => {
		trackPendingInbound(wallet.id, userId, V.txid, 50000);
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('txn-mempool-conflict');
			},
			async getHistory() {
				return [];
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(1);
		expect(replacedEvents[0].wasConfirmed).toBe(false);
	});

	it('!anyFetched (Electrum unreachable on every scripthash) yields NO reversal -- fail closed', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('not found');
			},
			async getHistory() {
				throw new Error('electrum unreachable');
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('notified'); // untouched
	});

	it('found in SOME watched history (a no-txindex miss on getTx alone) leaves the row untouched -- still present', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('not found');
			},
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }]; // still there
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('notified');
	});

	it('an own-send (net-negative delta in the wallet transactions table) vanishing is SILENT (dropped, no notification)', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		getDb()
			.prepare(
				`INSERT INTO transactions (wallet_id, txid, height, delta_sats) VALUES (?, ?, ?, -50000)`
			)
			.run(wallet.id, V.txid, V.height);
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('not found');
			},
			async getHistory() {
				return [];
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(0); // silent -- no tx_replaced
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('dropped');
	});

	it('a row deeper than REORG_RECHECK_DEPTH is never re-checked even if it later disappears', async () => {
		const deepHeight = V.height - REORG_RECHECK_DEPTH - 1;
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, deepHeight));
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				throw new Error('not found'); // would be a reorg IF re-checked
			},
			async getHistory() {
				return [];
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(0); // never even looked at -- outside the window
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('notified');
	});

	it('DEFAULT_MILESTONES is [1] (matching cairn, avoiding fatigue)', () => {
		expect(DEFAULT_MILESTONES).toEqual([1]);
	});

	// Regression (audit-verified, cairn-fzqpe): onReplaced used to run inside a
	// try/catch that swallowed a hook failure, so markReplaced's claim
	// committed even though the in-app notification write never happened --
	// permanently losing the "payment reversed" alert with no retry.
	it('a throwing onReplaced hook rolls back markReplaced too -- row stays notified, retries and fires on the next pass', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const rail = fakeRail({
			async getTx() {
				throw new Error('No such mempool or blockchain transaction');
			},
			async getHistory() {
				return [];
			}
		});
		let hookCalls = 0;
		await handleNewBlock(rail, floorAtTip(), true, {
			onReplaced: () => {
				hookCalls++;
				throw new Error('simulated hook write failure mid-INSERT');
			}
		});
		expect(hookCalls).toBe(1);
		// markReplaced must NOT have been committed alongside the failed hook
		// write -- the row stays 'notified', never silently advanced to
		// 'replaced' with nothing ever recorded.
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('notified');

		// The next pass (healthy hook) retries and fires successfully.
		const replacedEvents: ReplacedEvent[] = [];
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(1);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('replaced');
	});

	// Regression: Bitcoin Core commonly restores an invalidated block's
	// transactions straight back into the mempool rather than making them
	// unfetchable -- getTx keeps succeeding (confirmations drops to 0/absent)
	// with NO throw at all. Relying only on a "not found" throw would miss
	// this, the most common real-world reorg shape (confirmed by the
	// watchtower regtest e2e test).
	it('a tx reorged BACK INTO MEMPOOL (still fetchable, confirmations dropped below threshold, no throw) still fires tx_replaced', async () => {
		withTransaction((db) => claimReceived(db, wallet.id, userId, V.txid, 150000, V.height));
		const replacedEvents: ReplacedEvent[] = [];
		const rail = fakeRail({
			async getTx() {
				return { confirmations: 0 }; // fetchable, but no longer confirmed -- no throw
			},
			async getHistory() {
				return [{ tx_hash: V.txid, height: 0 }]; // back in mempool, not confirmed
			}
		});
		await handleNewBlock(rail, floorAtTip(), true, { afterReplaced: (e) => replacedEvents.push(e) });
		expect(replacedEvents.length).toBe(1);
		expect(replacedEvents[0].wasConfirmed).toBe(true);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('replaced');
	});
});
