/**
 * T1 headline acceptance (WATCHTOWER.md §6.1 fail-closed proofs, §6.3 dedup):
 * drives the REAL handleScripthashChange against a fake Electrum rail. A
 * mocked getMerkleProof/getBlockHeader/getHistory lets the real detection +
 * SPV-gate + ledger code run; only the network edge is faked.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations.js';
import { importWallet, syncWallet, deriveAddresses } from '../../wallet/index.js';
import type { Wallet } from '../../wallet/index.js';
import {
	createWatcherState,
	handleScripthashChange,
	type Watched,
	type WatcherElectrumRail,
	type WatcherState,
	type ReceivedEvent
} from './watcher.js';
import { getLedgerRow } from './ledger.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

// The same real, PoW-valid mainnet block-700000 vector used across spv.spec.ts
// / spvGate.spec.ts -- reused here so handleScripthashChange's SPV gate call
// genuinely verifies against real bytes end to end.
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
let sh0: string; // chain-0 index-0 scripthash
let spk0: string; // its scriptPubKey hex

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'owner')`).run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
	const [a0] = deriveAddresses(wallet, 0, 0, 1);
	sh0 = a0.scripthash;
	spk0 = a0.scriptPubKey;

	// Populate the `addresses` table for real (scan.ts's own write) so
	// listWalletScriptPubKeys (the direction/value computation's source) has
	// something real to read -- a fake rail with zero history is enough.
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

function watched(): Watched {
	return { walletId: wallet.id, userId, chain: 0, index: 0, address: '' };
}

function baseState(): WatcherState {
	const state = createWatcherState();
	state.baselineComplete = true;
	const w = watched();
	state.byScripthash.set(sh0, w);
	state.baselinedScripthashes.add(sh0); // skip the baseline gate by default
	return state;
}

/** A fake rail whose SPV surface always returns the REAL block-700000 proof
 *  (so verification genuinely succeeds), with an injectable getTx/getHistory. */
function fakeRail(overrides: Partial<WatcherElectrumRail> = {}): WatcherElectrumRail {
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
		async subscribeScripthash() {
			return null;
		},
		async unsubscribeScripthash() {
			return true;
		},
		async getTx() {
			return { vout: [{ n: 0, value: 0.0015, scriptPubKey: { hex: spk0 } }] };
		},
		...overrides
	};
}

function received(): { events: ReceivedEvent[] } {
	const bucket: { events: ReceivedEvent[] } = { events: [] };
	return bucket;
}

describe('T1: handleScripthashChange -- fail-closed proofs (WATCHTOWER.md §6.1)', () => {
	it('a confirmed, genuinely-verifiable new tx fires exactly once with the correct amount', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });

		expect(bucket.events.length).toBe(1);
		expect(bucket.events[0].txid).toBe(V.txid);
		expect(bucket.events[0].amountSats).toBe(150000);
		const row = getLedgerRow(wallet.id, userId, V.txid);
		expect(row?.status).toBe('notified');
	});

	it('unverifiable tx (merkle proof fetch throws) -> NO send, ledger untouched, retries later', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			},
			async getMerkleProof() {
				throw new Error('electrum down');
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });

		expect(bucket.events.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)).toBeNull(); // NOT recorded -- can retry

		// The next event, with a healthy rail, succeeds.
		const healthyRail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		await handleScripthashChange(state, healthyRail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(1);
	});

	it('a forged-txid false positive (hostile server, trivially-easy header) -> NO send (cairn-7zj6)', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex); // a real, hard floor exists
		const forgedBytes = new Uint8Array(80);
		forgedBytes.fill(3);
		forgedBytes[72] = 0xff;
		forgedBytes[73] = 0xff;
		forgedBytes[74] = 0x7f;
		forgedBytes[75] = 0x22; // trivially-easy target
		const forgedHex = Buffer.from(forgedBytes).toString('hex');
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height + 1 }]; // a NEW, uncached height
			},
			async getBlockHeader() {
				return forgedHex;
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)).toBeNull();
	});

	it('cold cache defers; the NEXT event (after a header warms the cache) fires exactly one', async () => {
		const state = baseState(); // floor starts empty -- cold
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)).toBeNull();

		// Warm the cache (as a real 'header' event would) and retry.
		state.floor.acceptHeader(V.height, V.headerHex);
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(1);
	});

	it('Electrum down (getHistory throws) -> no send, no throw, recovers on a later event', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				throw new Error('connection lost');
			}
		});
		const bucket = received();
		await expect(
			handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) })
		).resolves.toBeUndefined();
		expect(bucket.events.length).toBe(0);

		const healthyRail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		await handleScripthashChange(state, healthyRail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(1);
	});

	it('handleScripthashChange NEVER throws even when every rail call rejects', async () => {
		const state = baseState();
		const rail: WatcherElectrumRail = {
			getHistory: () => Promise.reject(new Error('x')),
			getMerkleProof: () => Promise.reject(new Error('x')),
			getBlockHeader: () => Promise.reject(new Error('x')),
			subscribeScripthash: () => Promise.reject(new Error('x')),
			unsubscribeScripthash: () => Promise.reject(new Error('x')),
			getTx: () => Promise.reject(new Error('x'))
		};
		await expect(handleScripthashChange(state, rail, sh0)).resolves.toBeUndefined();
		await expect(handleScripthashChange(state, rail, 'unknown-scripthash')).resolves.toBeUndefined();
	});

	it('ignores events entirely during startup warmup (baselineComplete=false)', async () => {
		const state = baseState();
		state.baselineComplete = false;
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)).toBeNull();
	});
});

describe('T1: per-scripthash baseline gate (cairn-u7bw/-3bt1)', () => {
	it('a never-before-seen scripthash baselines its ENTIRE history silently, without notifying', async () => {
		const state = createWatcherState();
		state.baselineComplete = true;
		state.byScripthash.set(sh0, watched());
		// NOT added to baselinedScripthashes -- simulates the very first event.
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		const bucket = received();
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });

		expect(bucket.events.length).toBe(0); // silent
		const row = getLedgerRow(wallet.id, userId, V.txid);
		expect(row?.status).toBeNull(); // baselined, not notified
		expect(state.baselinedScripthashes.has(sh0)).toBe(true);

		// A repeat event for the SAME (now-baselined) tx must stay suppressed
		// (status NULL is terminal-silent, WATCHTOWER.md §1.7).
		await handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(0);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBeNull();
	});
});

describe('T1: dedup -- mempool -> block collapses to ONE chain (WATCHTOWER.md §6.3)', () => {
	it('a tx seen first in mempool (pending, no fire) then confirmed fires exactly once, same ledger row', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex);
		const bucket = received();

		// First: mempool sighting.
		const mempoolRail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: 0 }];
			}
		});
		await handleScripthashChange(state, mempoolRail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(0);
		const pendingRow = getLedgerRow(wallet.id, userId, V.txid);
		expect(pendingRow?.status).toBe('pending');

		// Then: confirmed.
		const confirmedRail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		await handleScripthashChange(state, confirmedRail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(1);
		const notifiedRow = getLedgerRow(wallet.id, userId, V.txid);
		expect(notifiedRow?.status).toBe('notified');

		// A THIRD event re-reporting the same confirmed tx must not re-fire.
		await handleScripthashChange(state, confirmedRail, sh0, { afterReceived: (e) => bucket.events.push(e) });
		expect(bucket.events.length).toBe(1);
	});

	it('concurrent handleScripthashChange calls for the SAME scripthash: in-flight dedup lets exactly one process', async () => {
		const state = baseState();
		state.floor.acceptHeader(V.height, V.headerHex);
		const rail = fakeRail({
			async getHistory() {
				return [{ tx_hash: V.txid, height: V.height }];
			}
		});
		const bucket = received();
		const [a, b] = [
			handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) }),
			handleScripthashChange(state, rail, sh0, { afterReceived: (e) => bucket.events.push(e) })
		];
		await Promise.all([a, b]);
		expect(bucket.events.length).toBe(1); // not two
	});

	it('a restart between mempool and block does not double-fire (the ledger is durable, not in-memory)', async () => {
		const state1 = baseState();
		state1.floor.acceptHeader(V.height, V.headerHex);
		await handleScripthashChange(
			state1,
			fakeRail({
				async getHistory() {
					return [{ tx_hash: V.txid, height: 0 }];
				}
			}),
			sh0
		);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('pending');

		// Simulate a process restart: a BRAND NEW state object (in-memory maps
		// reset), same DB.
		const state2 = baseState();
		state2.floor.acceptHeader(V.height, V.headerHex);
		const bucket = received();
		await handleScripthashChange(
			state2,
			fakeRail({
				async getHistory() {
					return [{ tx_hash: V.txid, height: V.height }];
				}
			}),
			sh0,
			{ afterReceived: (e) => bucket.events.push(e) }
		);
		expect(bucket.events.length).toBe(1);
		expect(getLedgerRow(wallet.id, userId, V.txid)?.status).toBe('notified');
	});
});

describe('T1: wallet-vanished mid-flight (TOCTOU, cairn-mo36)', () => {
	it('a wallet deleted before processing prunes the watched entry and unsubscribes, no throw', async () => {
		const state = baseState();
		getDb().prepare('DELETE FROM wallets WHERE id = ?').run(wallet.id);
		let unsubscribed = false;
		const rail = fakeRail({
			async unsubscribeScripthash() {
				unsubscribed = true;
				return true;
			}
		});
		await expect(handleScripthashChange(state, rail, sh0)).resolves.toBeUndefined();
		expect(state.byScripthash.has(sh0)).toBe(false);
		// unsubscribe is fire-and-forget -- allow a tick for it to run.
		await new Promise((r) => setTimeout(r, 0));
		expect(unsubscribed).toBe(true);
	});
});
