/**
 * BC-UR crypto-psbt round-trip tests (SIGNING.md §5.3, re-scoped hearth-ui7):
 * encode a real PSBT into `ur:crypto-psbt/...` frames, shuffle/duplicate them,
 * feed `PsbtQrJoiner` out of order, and assert the reassembled base64 is
 * byte-identical to the input. A stray non-BC-UR frame, mixed totals, and a
 * corrupted checksum must all throw; a synthetic mixed fountain part must be
 * silently ignored rather than corrupt reassembly.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { encodePsbtToFrames, PsbtQrJoiner, looksLikeUrFrame, __test } from './jadeUr.js';

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
	const wallet = importWallet(userId, { name: 'BC-UR', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 5_000_000), userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 1_000_000 }],
		feeRate: 5
	});
	return built.psbtBase64;
}

describe('jadeUr.ts: encodePsbtToFrames + PsbtQrJoiner round-trip', () => {
	it('a single-frame PSBT round-trips', async () => {
		const psbt = await realUnsignedPsbt();
		// The fixture PSBT's CBOR message (~280 bytes) exceeds the default
		// 200-byte fragment cap and would naturally split into 2 frames --
		// raise the cap here to exercise the single-frame fast path explicitly.
		const frames = encodePsbtToFrames(psbt, { maxFragmentLen: 2000 });
		expect(frames.length).toBe(1);
		expect(frames[0].startsWith('ur:crypto-psbt/')).toBe(true);
		const joiner = new PsbtQrJoiner();
		let result;
		for (const f of frames) result = joiner.add(f);
		expect(result!.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
	});

	it('the default fragment cap naturally splits a real-size PSBT into multiple frames', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt);
		expect(frames.length).toBeGreaterThan(1);
		const joiner = new PsbtQrJoiner();
		let result;
		for (const f of frames) result = joiner.add(f);
		expect(result!.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
	});

	it('forced multi-frame split reassembles out of order with duplicates', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt, { minFragments: 4 });
		expect(frames.length).toBeGreaterThanOrEqual(4);
		expect(frames[0]).toMatch(/^ur:crypto-psbt\/1-\d+\//);

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
		const frames = encodePsbtToFrames(psbt, { minFragments: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]);
		expect(joiner.isComplete()).toBe(false);
		expect(joiner.progress().have).toBe(1);
		expect(joiner.missing().length).toBe(frames.length - 1);
	});

	it('a stray non-BC-UR frame throws', () => {
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add('B$2P0A01hello')).toThrow(/signed-transaction frame/i);
		expect(() => joiner.add('not a bc-ur frame at all')).toThrow(/signed-transaction frame/i);
	});

	it('looksLikeUrFrame distinguishes BC-UR frames from BBQr / plain text', async () => {
		const psbt = await realUnsignedPsbt();
		const [frame] = encodePsbtToFrames(psbt);
		expect(looksLikeUrFrame(frame)).toBe(true);
		expect(looksLikeUrFrame('B$2P0A01hello')).toBe(false);
		expect(looksLikeUrFrame(psbt)).toBe(false);
	});

	it('two different totals throw (mixed-sequence rejection)', async () => {
		const psbt = await realUnsignedPsbt();
		const framesA = encodePsbtToFrames(psbt, { minFragments: 3 });
		const psbtB = base64.encode(new Uint8Array(3000).fill(7));
		const framesB = encodePsbtToFrames(psbtB, { minFragments: 6 });

		const joiner = new PsbtQrJoiner();
		joiner.add(framesA[0]);
		expect(() => joiner.add(framesB[0])).toThrow(/two different transactions/i);
	});

	it('a corrupted checksum throws on decode', async () => {
		const psbt = await realUnsignedPsbt();
		const [frame] = encodePsbtToFrames(psbt, { maxFragmentLen: 2000 });
		// Swap the final 2-character bytewords code for a DIFFERENT, still-valid
		// one ("ae"/"ad" -- both real minimal codes, for bytes 0 and 1) so the
		// decode succeeds (a random single-character flip has decent odds of
		// landing on a code that isn't in the alphabet at all, which would
		// exercise the "invalid bytewords" branch instead of the checksum one).
		const tail = frame.slice(-2);
		const replacement = tail === 'ae' ? 'ad' : 'ae';
		const flipped = frame.slice(0, -2) + replacement;
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add(flipped)).toThrow(/checksum mismatch/i);
	});

	it('a synthetic mixed fountain part (seqNum > seqLen) is ignored, not corrupting reassembly', async () => {
		const psbt = await realUnsignedPsbt();
		const frames = encodePsbtToFrames(psbt, { minFragments: 4 });
		const seqLen = frames.length;

		// The wire format carries seqNum/seqLen AUTHORITATIVELY inside the
		// bytewords-encoded CBOR part, not just in the human-readable `<n>-<m>`
		// URL segment -- so building a real mixed part means decoding a real
		// pure frame's envelope and re-encoding it with an out-of-range seqNum,
		// via the test-only `__test` helpers (its fragment CONTENT is reused
		// unchanged; that's fine, since a seqNum > seqLen part is discarded
		// purely by the out-of-range seqNum, exactly matching what a real
		// BC-UR fountain encoder would interleave among the pure frames).
		const lastPure = frames[frames.length - 1];
		const lastPureMatch = /^ur:crypto-psbt\/\d+-\d+\/(.+)$/.exec(lastPure);
		expect(lastPureMatch).not.toBeNull();
		const decoded = __test.decodePart(__test.bytewordsDecode(lastPureMatch![1]));
		const mixedPart = __test.encodePart(seqLen + 1, decoded.seqLen, decoded.messageLen, decoded.checksum, decoded.fragment);
		const mixedFrame = `ur:crypto-psbt/${seqLen + 1}-${seqLen}/${__test.bytewordsEncode(mixedPart)}`;

		const joiner = new PsbtQrJoiner();
		// Feed the mixed part FIRST -- it must not set any pure fragment slot
		// and must not throw, since a real fountain encoder interleaves mixed
		// parts before every pure fragment has necessarily been seen.
		const afterMixed = joiner.add(mixedFrame);
		expect(afterMixed.complete).toBe(false);
		expect(afterMixed.progress.have).toBe(0); // ignored -- no pure fragment recorded

		// Now feed all the real pure fragments; completion must still succeed
		// and reassemble correctly despite the earlier mixed frame.
		let last;
		for (const f of frames) last = joiner.add(f);
		expect(last!.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
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

	it('__test.findNominalFragmentLength picks the smallest fragment count under the cap', () => {
		expect(__test.findNominalFragmentLength(100, 10, 50)).toBeLessThanOrEqual(50);
	});
});
