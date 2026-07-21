/**
 * BBQr round-trip tests (SIGNING.md §5.3): encode a real PSBT into animated-QR
 * frames, shuffle/duplicate/reverse them, feed `PsbtQrJoiner` out of order,
 * and assert the reassembled base64 is byte-identical to the input. A stray
 * non-BBQr frame and mixed totals must throw.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { encodePsbtToFrames, PsbtQrJoiner, looksLikeBbqrFrame } from './bbqr.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

function fundingNode(wallet: Wallet, coinSats: number): BuildNode {
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
	const txid = 'ab'.repeat(32);
	return {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history')
						return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
					return s === sh ? { confirmed: coinSats, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: coinSats, height: 800000 }] : [];
			},
			async getTransaction(t) {
				return { txid: t, vin: [], vout: [] };
			}
		}
	};
}

async function realUnsignedPsbt(): Promise<string> {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(5));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	const wallet = importWallet(userId, { name: 'QR', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 5_000_000), userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 1_000_000 }],
		feeRate: 5
	});
	return built.psbtBase64;
}

describe('bbqr.ts: encodePsbtToFrames + PsbtQrJoiner round-trip', () => {
	it('a single-frame PSBT round-trips', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt);
		const joiner = new PsbtQrJoiner();
		let result;
		for (const f of frames) result = joiner.add(f);
		expect(result!.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
	});

	it('forced multi-frame split reassembles out of order with duplicates', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt, { minSplit: 4 });
		expect(frames.length).toBeGreaterThanOrEqual(4);

		const joiner = new PsbtQrJoiner();
		// Shuffle, duplicate, and reverse-feed.
		const shuffled = [...frames].reverse();
		const withDupes = [...shuffled, ...shuffled.slice(0, 2)];
		let last;
		for (const f of withDupes) last = joiner.add(f);
		expect(last!.complete).toBe(true);
		expect(joiner.progress()).toEqual({ have: frames.length, total: frames.length });
		expect(joiner.result()).toBe(psbt);
	});

	it('reports accurate progress before completion', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt, { minSplit: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]);
		expect(joiner.isComplete()).toBe(false);
		expect(joiner.progress().have).toBe(1);
		expect(joiner.missing().length).toBe(frames.length - 1);
	});

	it('a stray non-BBQr frame throws', () => {
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add('not a bbqr frame at all')).toThrow(/signed-transaction frame/i);
	});

	it('two different totals throw (mixed-sequence rejection)', async () => {
		const psbt = await realUnsignedPsbt();
		const framesA = encodePsbtToFrames(psbt, { minSplit: 3 });
		const psbtB = base64.encode(new Uint8Array(2000).fill(7));
		// Build a differently-sized payload to force a different total.
		const framesB = encodePsbtToFrames(psbtB, { minSplit: 6 });
		expect(framesA[0].slice(0, 6)).not.toBe(framesB[0].slice(0, 6)); // sanity: different total field

		const joiner = new PsbtQrJoiner();
		joiner.add(framesA[0]);
		expect(() => joiner.add(framesB[0])).toThrow(/two different transactions/i);
	});

	it('looksLikeBbqrFrame distinguishes BBQr frames from BC-UR / plain text (T8, hearth-ui7)', async () => {
		const psbt = await realUnsignedPsbt();
		const [frame] = encodePsbtToFrames(psbt);
		expect(looksLikeBbqrFrame(frame)).toBe(true);
		expect(looksLikeBbqrFrame('ur:crypto-psbt/lpaaaacf')).toBe(false);
		expect(looksLikeBbqrFrame(psbt)).toBe(false);
	});

	it('reset() clears state for a fresh scan', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt);
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]);
		joiner.reset();
		expect(joiner.progress()).toEqual({ have: 0, total: 0 });
		expect(joiner.isComplete()).toBe(false);
	});
});
