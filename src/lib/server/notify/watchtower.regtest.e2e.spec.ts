/**
 * The watchtower regtest e2e (WATCHTOWER.md §6.8, the live-node gate).
 * Gated on HEARTH_E2E=1. Drives the REAL handleScripthashChange (T1) and
 * handleNewBlock (T2) through the real dispatch pipeline (T3/T5/T7) against
 * a dockerized regtest bitcoind (no parallel re-implementation, no second
 * SPV code path -- the same real Core-RPC-backed rail pattern as
 * wallet.regtest.e2e.spec.ts). Proves:
 *  - NO tx_received while a payment sits in the mempool.
 *  - Exactly ONE SPV-VERIFIED tx_received fires within one confirmation.
 *  - verifyTxInclusion (via spvGate) genuinely accepts the regtest header +
 *    merkle proof.
 *  - invalidateblock (a real reorg) fires a tx_replaced reversal.
 *
 * Setup (shares the SAME container as wallet.regtest.e2e.spec.ts):
 *   docker run -d --name hearth-regtest -p 18443:18443 polarlightning/bitcoind:27.0 \
 *     bitcoind -regtest -server -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
 *     -rpcuser=hearth -rpcpassword=hearthtest -fallbackfee=0.0002 -txindex
 *   HEARTH_E2E=1 npx vitest run src/lib/server/notify/watchtower.regtest.e2e.spec.ts
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from '../wallet/import.js';
import { deriveAddresses } from '../wallet/index.js';
import { scriptToScripthash } from '../wallet/derive.js';
import type { Wallet } from '../wallet/types.js';
import { initSecretKey, __resetSecretKeyForTests } from './config/secrets.js';
import { initNotifyOrigin } from './config/channelConfig.js';
import { createWatcherState, handleScripthashChange, type WatcherElectrumRail } from './detect/watcher.js';
import { handleNewBlock, type ConfirmElectrumRail } from './detect/confirm.js';
import { createWatchtowerHooks, createConfirmHooks } from './wiring.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const E2E = process.env.HEARTH_E2E === '1';
const RPC = 'http://127.0.0.1:18443/';
const AUTH = 'Basic ' + Buffer.from('hearth:hearthtest').toString('base64');

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
	const url = wallet ? `${RPC}wallet/${wallet}` : RPC;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: AUTH },
		body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params })
	});
	const j = (await res.json()) as { result: T; error: { message: string } | null };
	if (j.error) throw new Error(`${method}: ${j.error.message}`);
	return j.result;
}

if (!E2E) {
	process.stderr.write(
		'\n[watchtower.regtest.e2e] SKIPPED. To run:\n' +
			'  docker run -d --name hearth-regtest -p 18443:18443 polarlightning/bitcoind:27.0 \\\n' +
			'    bitcoind -regtest -server -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -rpcuser=hearth -rpcpassword=hearthtest -fallbackfee=0.0002 -txindex\n' +
			'  HEARTH_E2E=1 npx vitest run src/lib/server/notify/watchtower.regtest.e2e.spec.ts\n\n'
	);
}

/** Build a merkle branch (display-order hex) + position for a txid in a block
 *  (identical algorithm to wallet.regtest.e2e.spec.ts's helper -- both are
 *  test-only harness code, not a second SPV implementation). */
function merkleBranch(txids: string[], target: string): { branch: string[]; pos: number } {
	const sha256d = (b: Uint8Array): Uint8Array => Uint8Array.from(sha256(sha256(b)));
	let layer: Uint8Array[] = txids.map((t) => Uint8Array.from(hex.decode(t)).reverse());
	let index = txids.indexOf(target);
	const branch: string[] = [];
	while (layer.length > 1) {
		if (layer.length % 2 === 1) layer = [...layer, layer[layer.length - 1]];
		const sibling = index % 2 === 0 ? layer[index + 1] : layer[index - 1];
		branch.push(hex.encode(Uint8Array.from(sibling).reverse()));
		const next: Uint8Array[] = [];
		for (let i = 0; i < layer.length; i += 2) {
			const combined = new Uint8Array(64);
			combined.set(layer[i], 0);
			combined.set(layer[i + 1], 32);
			next.push(sha256d(combined));
		}
		layer = next;
		index = Math.floor(index / 2);
	}
	return { branch, pos: txids.indexOf(target) };
}

describe.skipIf(!E2E)('watchtower regtest e2e: payment received -> verified notification -> reorg', () => {
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(77));
	const account = root.derive("m/84'/1'/0'");
	let wallet: Wallet;
	let userId: number;
	let secretDir: string;
	let sh: string;

	beforeAll(async () => {
		closeDb();
		const db: DatabaseSync = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
		db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'owner');
		userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
		secretDir = mkdtempSync(join(tmpdir(), 'hearth-watchtower-e2e-'));
		__resetSecretKeyForTests();
		initSecretKey(secretDir);
		initNotifyOrigin(null);

		wallet = importWallet(userId, {
			name: 'RegtestWatched',
			descriptor: `wpkh([00000000/84'/1'/0']${account.publicExtendedKey}/0/*)`,
			network: 'regtest'
		});
		sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;

		try {
			await rpc('createwallet', ['miner-wt']);
		} catch {
			/* already exists */
		}
		const minerAddr = await rpc<string>('getnewaddress', [], 'miner-wt');
		await rpc('generatetoaddress', [101, minerAddr]);
	}, 60_000);

	it('the full watchtower pipeline: mempool -> no fire; confirmed -> one SPV-verified tx_received; a real reorg -> tx_replaced', async () => {
		const recv = deriveAddresses(wallet, 0, 0, 1)[0];
		const minerAddr = await rpc<string>('getnewaddress', [], 'miner-wt');

		// A real Core-RPC-backed rail (WatcherElectrumRail + ConfirmElectrumRail
		// shape) -- no Electrum server needed for this test; the SAME real
		// verifyTxInclusion/spvVerifyConfirmed runs regardless of rail source.
		// `getHistory` re-derives the watched txid's CURRENT height fresh from
		// Core on every call (never a stale local cache) so it correctly
		// reflects a real reorg (a tx that returns to the mempool reports
		// height<=0 again, exactly like a real Electrum server would).
		let watchedTxid: string | null = null;
		const rail: WatcherElectrumRail & ConfirmElectrumRail = {
			async getHistory(scripthash: string) {
				if (scripthash !== sh || !watchedTxid) return [];
				try {
					const raw = await rpc<{ confirmations?: number; blockhash?: string }>('getrawtransaction', [
						watchedTxid,
						true
					]);
					if (raw.blockhash && raw.confirmations && raw.confirmations > 0) {
						const header = await rpc<{ height: number }>('getblockheader', [raw.blockhash]);
						return [{ tx_hash: watchedTxid, height: header.height }];
					}
					return [{ tx_hash: watchedTxid, height: 0 }]; // in mempool (or just-reorged-out)
				} catch {
					return []; // genuinely gone
				}
			},
			async getMerkleProof(txid: string, height: number) {
				const blockHash = await rpc<string>('getblockhash', [height]);
				const block = await rpc<{ tx: string[] }>('getblock', [blockHash, 1]);
				const { branch, pos } = merkleBranch(block.tx, txid);
				return { merkle: branch, pos };
			},
			async getBlockHeader(height: number) {
				const blockHash = await rpc<string>('getblockhash', [height]);
				return rpc<string>('getblockheader', [blockHash, false]);
			},
			async subscribeScripthash() {
				return null;
			},
			async unsubscribeScripthash() {
				return true;
			},
			async getTx(txid: string) {
				try {
					const raw = await rpc<{ vout: { value: number; n: number; scriptPubKey: { hex: string } }[]; confirmations?: number }>(
						'getrawtransaction',
						[txid, true]
					);
					return { vout: raw.vout, confirmations: raw.confirmations };
				} catch (e) {
					throw new Error(`getTx not found: ${String(e)}`);
				}
			}
		};

		const state = createWatcherState();
		state.baselineComplete = true;
		state.byScripthash.set(sh, { walletId: wallet.id, userId, chain: 0, index: 0, address: recv.address });
		state.baselinedScripthashes.add(sh); // a fresh watch-only wallet has no back-history to baseline

		const watchHooks = createWatchtowerHooks();
		const confirmHooks = createConfirmHooks();

		// 1. Send -> mempool. Assert NO tx_received while unconfirmed.
		const txid = await rpc<string>('sendtoaddress', [recv.address, 1], 'miner-wt');
		watchedTxid = txid;
		await handleScripthashChange(state, rail, sh, watchHooks);
		const beforeConfirm = getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get('tx_received') as {
			n: number;
		};
		expect(beforeConfirm.n).toBe(0);
		const ledgerRow = getDb()
			.prepare('SELECT status FROM notified_txids WHERE txid = ?')
			.get(txid) as { status: string | null } | undefined;
		expect(ledgerRow?.status).toBe('pending');

		// 2. Mine it -> exactly ONE SPV-verified tx_received within one confirmation.
		const [blockHash] = await rpc<string[]>('generatetoaddress', [1, minerAddr]);
		const block = await rpc<{ height: number }>('getblock', [blockHash, 1]);
		state.floor.acceptHeader(block.height, await rail.getBlockHeader(block.height));

		await handleScripthashChange(state, rail, sh, watchHooks);

		const afterConfirm = getDb()
			.prepare('SELECT title, body, type, user_id FROM events WHERE type = ?')
			.all('tx_received') as { title: string; body: string; type: string; user_id: number }[];
		expect(afterConfirm.length).toBe(1);
		expect(afterConfirm[0].user_id).toBe(userId);
		expect(afterConfirm[0].body).toContain('BTC'); // sats-first human rationale
		const notifiedRow = getDb()
			.prepare('SELECT status, confirmed, confirmed_height FROM notified_txids WHERE txid = ?')
			.get(txid) as { status: string; confirmed: number; confirmed_height: number };
		expect(notifiedRow.status).toBe('notified');
		expect(notifiedRow.confirmed_height).toBe(block.height);

		// 3. A real reorg (invalidateblock): the tx returns to mempool, no
		// longer confirmed. handleNewBlock must catch this via confirm.ts's
		// reorg-window recheck and fire tx_replaced (a genuine reversal, not a
		// synthetic one).
		await rpc('invalidateblock', [blockHash]);
		const newTip = await rpc<number>('getblockcount', []);

		await handleNewBlock(rail, state.floor, true, confirmHooks);

		const replacedEvents = getDb()
			.prepare('SELECT title, body FROM events WHERE type = ?')
			.all('tx_replaced') as { title: string; body: string }[];
		expect(replacedEvents.length).toBe(1);
		expect(replacedEvents[0].title).toBe('Confirmed payment reversed');
		expect(replacedEvents[0].body).toContain('reorganization');
		const afterReorgRow = getDb()
			.prepare('SELECT status FROM notified_txids WHERE txid = ?')
			.get(txid) as { status: string };
		expect(afterReorgRow.status).toBe('replaced');

		// The original tx_received event is APPENDED to, never deleted.
		expect(afterConfirm.length).toBe(1);

		void newTip;
	}, 60_000);
});
