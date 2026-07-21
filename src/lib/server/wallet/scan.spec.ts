/**
 * T4 acceptance (WALLET-ENGINE §7): gap-limit scan against a FAKE Electrum rail
 * (the real engine code runs). Balances match the faked node; import-with-
 * history converges (finds activity, stops after 20 empty); truncation flag at
 * HARD_CAP; SWR page-load reads the snapshot synchronously (no rail call).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet, syncWallet, getBalance, getUtxos, getSnapshot, getHistory } from './index.js';
import { deriveAddresses } from './index.js';
import { GAP_LIMIT, HARD_CAP, type ScanRail } from './scan.js';
import { scriptToScripthash } from './derive.js';
import { hex } from '@scure/base';
import type { Wallet } from './types.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/** A fake Electrum rail driven by a scripthash -> {history, balance, utxos} map. */
class FakeRail implements ScanRail {
	calls = 0;
	constructor(
		private readonly data: Map<
			string,
			{ history: { tx_hash: string; height: number }[]; confirmed: number; unconfirmed: number; utxos?: { tx_hash: string; tx_pos: number; value: number; height: number }[] }
		>
	) {}
	async batchRequest(items: { method: string; params: unknown[] }[]): Promise<unknown[]> {
		this.calls++;
		return items.map((it) => {
			const sh = it.params[0] as string;
			const d = this.data.get(sh);
			if (it.method === 'blockchain.scripthash.get_history') return d?.history ?? [];
			return { confirmed: d?.confirmed ?? 0, unconfirmed: d?.unconfirmed ?? 0 };
		});
	}
	async listUnspent(scripthash: string) {
		return this.data.get(scripthash)?.utxos ?? [];
	}
	async getTransaction(txid: string) {
		// Minimal verbose tx: one output paying nothing we can attribute (delta ok
		// to be 0 for these balance-focused tests).
		return { txid, vin: [], vout: [], blocktime: 1700000000 };
	}
}

let userId: number;
beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'owner');
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
});

function shOf(wallet: Wallet, chain: 0 | 1, index: number): string {
	return deriveAddresses(wallet, chain, index, 1)[0].scripthash;
}

describe('T4: gap-limit scan + SWR', () => {
	it('finds balance on address 0 and matches the faked node', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const sh0 = shOf(wallet, 0, 0);
		const data = new Map([
			[
				sh0,
				{
					history: [{ tx_hash: 'aa'.repeat(32), height: 800000 }],
					confirmed: 150000,
					unconfirmed: 0,
					utxos: [{ tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 150000, height: 800000 }]
				}
			]
		]);
		await syncWallet({ electrum: new FakeRail(data), tipHeight: 800100 }, wallet.id, { forceRefresh: true });

		const bal = getBalance(wallet.id);
		expect(bal.confirmedSats).toBe(150000);
		const utxos = getUtxos(wallet.id);
		expect(utxos.length).toBe(1);
		expect(utxos[0].valueSats).toBe(150000);
		expect(utxos[0].chain).toBe(0);
	});

	it('converges: discovers a gap of used addresses then stops after 20 empty', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		// Use addresses 0..4 on chain 0, then nothing.
		const data = new Map<string, { history: { tx_hash: string; height: number }[]; confirmed: number; unconfirmed: number }>();
		for (let i = 0; i <= 4; i++) {
			data.set(shOf(wallet, 0, i), {
				history: [{ tx_hash: hex.encode(new Uint8Array(32).fill(i + 1)), height: 700000 + i }],
				confirmed: 1000,
				unconfirmed: 0
			});
		}
		await syncWallet({ electrum: new FakeRail(data), tipHeight: 800000 }, wallet.id, { forceRefresh: true });
		const snap = getSnapshot(wallet.id);
		expect(snap).not.toBeNull();
		expect(snap!.usedCount).toBe(5);
		expect(snap!.confirmedSats).toBe(5000);
		expect(snap!.truncated).toBe(false);
	});

	it('sets the truncation flag when activity persists to HARD_CAP', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		// Every chain-0 address up to well past HARD_CAP is used -> never hits the gap.
		const rail: ScanRail = {
			async batchRequest(items) {
				return items.map((it) =>
					it.method === 'blockchain.scripthash.get_history'
						? [{ tx_hash: 'bb'.repeat(32), height: 1 }]
						: { confirmed: 1, unconfirmed: 0 }
				);
			},
			async listUnspent() {
				return [];
			},
			async getTransaction(txid) {
				return { txid, vin: [], vout: [] };
			}
		};
		await syncWallet({ electrum: rail, tipHeight: 1 }, wallet.id, { forceRefresh: true });
		const snap = getSnapshot(wallet.id);
		expect(snap!.truncated).toBe(true);
		// Never derives past the hard cap.
		expect(snap!.addressCount).toBeLessThanOrEqual(HARD_CAP * 2);
	});

	it('SWR read returns the snapshot synchronously without touching the rail', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const rail = new FakeRail(new Map());
		await syncWallet({ electrum: rail, tipHeight: 1 }, wallet.id, { forceRefresh: true });
		const callsAfterSync = rail.calls;
		// A page-load style read with NO node passed cannot make a rail call.
		const bal = getBalance(wallet.id);
		expect(bal.confirmedSats).toBe(0);
		expect(rail.calls).toBe(callsAfterSync);
	});

	it('stops at the gap limit (does not scan 400 addresses for an empty wallet)', async () => {
		const wallet = importWallet(userId, { name: 'Empty', xpub: ZPUB });
		const rail = new FakeRail(new Map());
		await syncWallet({ electrum: rail, tipHeight: 1 }, wallet.id, { forceRefresh: true });
		const snap = getSnapshot(wallet.id);
		// GAP_LIMIT addresses per chain (external+internal), give or take a batch.
		expect(snap!.addressCount).toBeLessThanOrEqual(GAP_LIMIT * 2 + 2);
	});

	// Regression (M3 live-found bug, hearth-lm1.14): a used address whose coin
	// has since been fully spent leaves NO UTXO behind. The scan used to build
	// its detailed-tx set only from `utxos`, so a wallet with used-but-now-empty
	// addresses (confirmedSats=0, usedCount>0) silently reported txCount=0 and
	// history=[] -- exactly the dev-DB canonical BIP-84 test zpub's shape.
	it('populates history for a used address with NO current UTXO (fully spent elsewhere)', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const sh0 = shOf(wallet, 0, 0);
		const txid = 'cc'.repeat(32);
		const data = new Map([
			[
				sh0,
				{
					history: [{ tx_hash: txid, height: 750000 }],
					confirmed: 0,
					unconfirmed: 0
					// no `utxos` entry -- the coin received at this address was spent
					// elsewhere and nothing currently sits at this scripthash.
				}
			]
		]);
		await syncWallet({ electrum: new FakeRail(data), tipHeight: 800100 }, wallet.id, { forceRefresh: true });

		const snap = getSnapshot(wallet.id);
		expect(snap!.usedCount).toBe(1);
		expect(snap!.confirmedSats).toBe(0);
		expect(snap!.txCount).toBe(1); // <- was 0 before the fix

		const history = getHistory(wallet.id);
		expect(history.length).toBe(1);
		expect(history[0].txid).toBe(txid);
		expect(history[0].height).toBe(750000); // from get_history, not a UTXO
	});
});
