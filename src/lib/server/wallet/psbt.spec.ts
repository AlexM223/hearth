/**
 * T5 acceptance (build side): buildPsbt persists a draft + inputs, reviewSummary
 * reconstructs it, multisig stamps N bip32Derivations on inputs AND change.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from './import.js';
import { buildPsbt, reviewSummary } from './psbt.js';
import { deriveAddresses } from './index.js';
import { scriptToScripthash } from './derive.js';
import type { BuildNode } from './psbt.js';
import type { Wallet } from './types.js';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/** A fake node that funds address 0/0 with one big coin. */
function fundingNode(wallet: Wallet, coinSats: number): BuildNode {
	const a0 = deriveAddresses(wallet, 0, 0, 1)[0];
	const sh = a0.scripthash;
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
			async getTransaction(txid2) {
				return { txid: txid2, vin: [], vout: [] };
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

describe('T5: buildPsbt (single-sig)', () => {
	it('builds a draft, persists inputs, and returns a review with change', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const node = fundingNode(wallet, 1_000_000);
		const recipient = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
		const built = await buildPsbt(node, userId, wallet.id, {
			recipients: [{ address: recipient, amountSats: 100_000 }],
			feeRate: 10
		});
		expect(built.review.recipients[0].amountSats).toBe(100_000);
		expect(built.review.changeAmountSats).not.toBeNull();
		expect(built.review.progress.required).toBe(1);
		expect(built.review.progress.collected).toBe(0);

		// psbt_draft_inputs is populated (authoritative reservation source).
		const inputRows = getDb()
			.prepare('SELECT COUNT(*) c FROM psbt_draft_inputs WHERE draft_id = ?')
			.get(built.draftId) as { c: number };
		expect(inputRows.c).toBeGreaterThan(0);

		// The PSBT parses and has an input + >=2 outputs (recipient + change).
		const tx = btc.Transaction.fromPSBT(base64.decode(built.psbtBase64));
		expect(tx.inputsLength).toBe(1);
		expect(tx.outputsLength).toBe(2);
	});

	it('reviewSummary round-trips a stored draft', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amountSats: 100_000 }],
			feeRate: 10
		});
		const review = reviewSummary(userId, wallet.id, built.draftId);
		expect(review.feeSats).toBe(built.review.feeSats);
		expect(review.totalInputSats).toBe(1_000_000);
	});

	// Regression (red-team money-path review, LOW-1): a legacy p2pkh input only
	// ever carries `nonWitnessUtxo` (single.ts inputMeta), never `witnessUtxo`.
	// reviewSummary used to reconstruct totalInputSats by reading
	// ONLY inp.witnessUtxo.amount, so a re-fetched review of a p2pkh (or bare
	// p2sh) draft silently reported totalInputSats=0 and a negative
	// changeAmountSats -- even though the actual built PSBT, fee, and
	// recipients were correct. Must now read the authoritative
	// psbt_draft_inputs values instead.
	it('reviewSummary reports the real totalInputSats for a legacy p2pkh draft (not 0)', async () => {
		// A standard "xpub..." (not zpub/ypub) infers p2pkh by SLIP-132 version.
		const XPUB =
			'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';
		const wallet = importWallet(userId, { name: 'Legacy', xpub: XPUB, scriptType: 'p2pkh' });
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amountSats: 100_000 }],
			feeRate: 10
		});
		expect(built.review.totalInputSats).toBe(1_000_000); // the FIRST review was always correct

		const review = reviewSummary(userId, wallet.id, built.draftId);
		expect(review.totalInputSats).toBe(1_000_000); // was 0 before the fix
		expect(review.changeAmountSats).not.toBeNull();
		expect(review.changeAmountSats!).toBeGreaterThan(0); // was negative before the fix
	});
});

describe('T5: buildPsbt (multisig stamps N derivations on inputs AND change)', () => {
	function make2of3(): Wallet {
		const cos = [1, 2, 3].map((s) => {
			const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(s));
			const acct = root.derive("m/48'/0'/0'/2'");
			return { xpub: acct.publicExtendedKey, fingerprint: hex.encode(u32(root.fingerprint)), path: "m/48'/0'/0'/2'" };
		});
		return importWallet(userId, { name: 'Vault', cosigners: cos, threshold: 2, scriptType: 'p2wsh' });
	}
	function u32(n: number): Uint8Array {
		return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
	}

	it('builds a multisig draft with N=3 derivations on every input and on change', async () => {
		const wallet = make2of3();
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amountSats: 100_000 }],
			feeRate: 5
		});
		const tx = btc.Transaction.fromPSBT(base64.decode(built.psbtBase64));
		expect((tx.getInput(0).bip32Derivation ?? []).length).toBe(3);
		expect(tx.getInput(0).witnessScript).toBeInstanceOf(Uint8Array);
		// Find the change output (the one carrying bip32Derivation) and assert N=3.
		let changeDerivs = 0;
		for (let i = 0; i < tx.outputsLength; i++) {
			const d = (tx.getOutput(i) as { bip32Derivation?: unknown[] }).bip32Derivation;
			if (d && d.length) changeDerivs = d.length;
		}
		expect(changeDerivs).toBe(3);
		expect(built.review.progress.required).toBe(2);
	});
});
