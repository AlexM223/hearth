/**
 * T6 acceptance (WALLET-ENGINE §5.4, §6.4): reservation. Reserved coins excluded
 * from auto-selection; two concurrent buildPsbt pick disjoint inputs (build
 * lock + indexed reservation); coin-control warns on a reserved coin; expiry
 * sweep and abandon free the coins again.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from './import.js';
import { buildPsbt, type BuildNode } from './psbt.js';
import { reservedOutpoints, reservationWarnings, abandonDraft, sweepExpired } from './reserve.js';
import { deriveAddresses } from './index.js';
import type { Wallet } from './types.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

/** A node funding two receive addresses (0/0 and 0/1), each with `coinSats`. */
function twoCoinNode(wallet: Wallet, coinSats: number): BuildNode {
	const a0 = deriveAddresses(wallet, 0, 0, 1)[0];
	const a1 = deriveAddresses(wallet, 0, 1, 1)[0];
	const map = new Map([
		[a0.scripthash, { txid: 'a0'.repeat(32), addr: a0.address }],
		[a1.scripthash, { txid: 'a1'.repeat(32), addr: a1.address }]
	]);
	return {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					const hit = map.get(s);
					if (it.method === 'blockchain.scripthash.get_history')
						return hit ? [{ tx_hash: hit.txid, height: 800000 }] : [];
					return hit ? { confirmed: coinSats, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				const hit = map.get(scripthash);
				return hit ? [{ tx_hash: hit.txid, tx_pos: 0, value: coinSats, height: 800000 }] : [];
			},
			async getTransaction(txid) {
				return { txid, vin: [], vout: [] };
			}
		}
	};
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

describe('T6: reservation', () => {
	it('two concurrent buildPsbt pick DISJOINT inputs (no coin double-reserved)', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = twoCoinNode(wallet, 200_000);
		const [a, b] = await Promise.all([
			buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 }),
			buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 })
		]);
		const aOut = a.review.inputs.map((i) => `${i.txid}:${i.vout}`);
		const bOut = b.review.inputs.map((i) => `${i.txid}:${i.vout}`);
		const overlap = aOut.filter((x) => bOut.includes(x));
		expect(overlap).toEqual([]);
		expect(a.draftId).not.toBe(b.draftId);
		// Both coins now reserved.
		expect(reservedOutpoints(userId).size).toBe(2);
	});

	it('a reserved coin is excluded from a later auto-build (insufficient funds)', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = twoCoinNode(wallet, 150_000);
		await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
		await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
		// Both 150k coins now reserved; a third 100k send cannot be funded.
		await expect(
			buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 })
		).rejects.toThrow();
	});

	it('coin-control warns when re-targeting a reserved coin', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = twoCoinNode(wallet, 200_000);
		const first = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
		const reservedOutpoint = first.review.inputs[0];
		const warnings = reservationWarnings(userId, [{ txid: reservedOutpoint.txid, vout: reservedOutpoint.vout }]);
		expect(warnings.length).toBe(1);
		expect(warnings[0].draftIds).toContain(first.draftId);
	});

	it('abandonDraft frees the reserved coins', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = twoCoinNode(wallet, 200_000);
		const built = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
		expect(reservedOutpoints(userId).size).toBe(1);
		expect(abandonDraft(userId, wallet.id, built.draftId)).toBe(true);
		expect(reservedOutpoints(userId).size).toBe(0);
	});

	it('expiry sweep abandons a stale draft and frees its inputs', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = twoCoinNode(wallet, 200_000);
		const built = await buildPsbt(node, userId, wallet.id, { recipients: [{ address: RECIP, amountSats: 100_000 }], feeRate: 5 });
		// Force the draft past its TTL.
		getDb().prepare('UPDATE psbt_drafts SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', built.draftId);
		const swept = sweepExpired(wallet.id);
		expect(swept).toBe(1);
		expect(reservedOutpoints(userId).size).toBe(0);
	});
});
