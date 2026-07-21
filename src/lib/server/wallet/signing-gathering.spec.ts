/**
 * T6 acceptance (SIGNING.md §5.4): the multisig gathering state machine,
 * driven through the real engine. A 2-of-3 draft: cosigner A's signature ->
 * collected===1, complete===false; cosigner B's -> collected===2,
 * complete===true; resubmitting A's signature is idempotent
 * (collected stays 2); a foreign signature is refused (ForeignSignatureError);
 * a non-SIGHASH_ALL signature is refused (WrongSighashError); the
 * slider-enable predicate (`complete`) flips exactly at the Mth signature.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet, buildPsbt, applySignature, deriveAddresses, type BuildNode } from './index.js';
import { ForeignSignatureError, WrongSighashError } from './errors.js';
import type { Wallet } from './types.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ORIGIN = "m/48'/0'/0'/2'";

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

function signAs(psbtB64: string, root: HDKey): string {
	const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
	for (let i = 0; i < tx.inputsLength; i++) {
		for (const chain of [0, 1] as const) {
			for (let idx = 0; idx < 3; idx++) {
				try {
					tx.signIdx(root.derive(ORIGIN).deriveChild(chain).deriveChild(idx).privateKey!, i);
				} catch {
					/* not this cosigner's key at this path */
				}
			}
		}
	}
	return base64.encode(tx.toPSBT());
}

let userId: number;
let wallet: Wallet;
let draftId: number;
let unsignedPsbt: string;
let rootA: HDKey, rootB: HDKey, rootC: HDKey;

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;

	rootA = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
	rootB = HDKey.fromMasterSeed(new Uint8Array(32).fill(2));
	rootC = HDKey.fromMasterSeed(new Uint8Array(32).fill(3));
	const [a, b, c] = [rootA, rootB, rootC].map((r) => r.derive(ORIGIN));
	const fps = [rootA, rootB, rootC].map((r) => r.fingerprint.toString(16).padStart(8, '0'));
	const descriptor = `wsh(sortedmulti(2,[${fps[0]}/48'/0'/0'/2']${a.publicExtendedKey}/0/*,[${fps[1]}/48'/0'/0'/2']${b.publicExtendedKey}/0/*,[${fps[2]}/48'/0'/0'/2']${c.publicExtendedKey}/0/*))`;
	wallet = importWallet(userId, { name: 'Vault', descriptor });

	const built = await buildPsbt(fundingNode(wallet, 2_000_000), userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 500_000 }],
		feeRate: 5
	});
	draftId = built.draftId;
	unsignedPsbt = built.psbtBase64;
});

describe('T6: multisig gathering state machine (2-of-3)', () => {
	it('collected/complete progress as each cosigner signs, and resubmission is idempotent', () => {
		const signedByA = signAs(unsignedPsbt, rootA);
		const first = applySignature(userId, wallet.id, draftId, signedByA);
		expect(first.progress.collected).toBe(1);
		expect(first.progress.complete).toBe(false); // the slider-enable predicate: NOT yet

		// Resubmitting A's own signature is a no-op (combine is idempotent).
		const resubmit = applySignature(userId, wallet.id, draftId, signedByA);
		expect(resubmit.progress.collected).toBe(1);
		expect(resubmit.progress.complete).toBe(false);

		// A second cosigner signs the same ORIGINAL unsigned draft independently
		// (their own device/file/QR round trip never saw A's signature) --
		// combine() merges both regardless of which base each signer started from.
		const signedByB = signAs(unsignedPsbt, rootB);
		const second = applySignature(userId, wallet.id, draftId, signedByB);
		expect(second.progress.collected).toBe(2);
		expect(second.progress.complete).toBe(true); // flips exactly at M=2
	});

	it('a foreign signature (key not a cosigner of this input) is refused', () => {
		const outsider = HDKey.fromMasterSeed(new Uint8Array(32).fill(99));
		const tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbt));
		// Forge a partialSig from a non-cosigner key directly (bypassing signIdx's
		// own key-membership assumptions) to simulate a hostile/buggy signer.
		const outsiderChild = outsider.derive(ORIGIN).deriveChild(0).deriveChild(0);
		const fakeSig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01]);
		tx.updateInput(0, { partialSig: [[outsiderChild.publicKey!, fakeSig]] });
		const forged = base64.encode(tx.toPSBT());

		expect(() => applySignature(userId, wallet.id, draftId, forged)).toThrow(ForeignSignatureError);
	});

	it('a non-SIGHASH_ALL signature is refused', () => {
		const tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbt));
		const cosignerPubkey = tx.getInput(0).bip32Derivation![0][0];
		const sigNotAll = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02]); // trailing 0x02 = SIGHASH_NONE
		tx.updateInput(0, { partialSig: [[cosignerPubkey, sigNotAll]] });
		const bad = base64.encode(tx.toPSBT());

		expect(() => applySignature(userId, wallet.id, draftId, bad)).toThrow(WrongSighashError);
	});
});
