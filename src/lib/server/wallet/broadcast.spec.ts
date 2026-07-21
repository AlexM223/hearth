/**
 * T7 acceptance (WALLET-ENGINE §6.3, §6.4): the ONE broadcast path, dynamic.
 * Both single-sig AND multisig sends reach the SAME node.broadcast spy; four
 * concurrent broadcasts of one draft -> exactly one network send + three
 * AlreadyBroadcastError; the txid-forgery guard refuses a lying rail; the RBF
 * partial-unique index yields exactly one live replacement.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from './import.js';
import { buildPsbt, applySignature, type BuildNode } from './psbt.js';
import { broadcastDraft } from './broadcast.js';
import { deriveAddresses } from './index.js';
import { AlreadyBroadcastError, AlreadyReplacedError, WalletError } from './errors.js';
import type { Wallet } from './types.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

function u32(n: number): Uint8Array {
	return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** A funding node that credits address 0/0 with one coin. */
function fundingNode(wallet: Wallet, coinSats: number, txid = 'ab'.repeat(32)): BuildNode {
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
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

/** A broadcast spy: returns the correct txid parsed from the raw tx. */
function spyNode(overrideTxid?: string) {
	const calls: string[] = [];
	return {
		calls,
		async broadcast(rawHex: string): Promise<string> {
			calls.push(rawHex);
			return overrideTxid ?? btc.Transaction.fromRaw(hex.decode(rawHex)).id;
		}
	};
}

/** Sign every input of a PSBT with a single-sig wallet's child privkeys. */
function signSingle(psbtB64: string, root: HDKey): string {
	const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
	for (let i = 0; i < tx.inputsLength; i++) {
		for (const chain of [0, 1] as const) {
			for (let idx = 0; idx < 5; idx++) {
				try {
					tx.signIdx(root.derive("m/84'/0'/0'").deriveChild(chain).deriveChild(idx).privateKey!, i);
					break;
				} catch {
					/* try next path */
				}
			}
		}
	}
	return base64.encode(tx.toPSBT());
}

function signMultisig(psbtB64: string, root: HDKey): string {
	const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
	for (let i = 0; i < tx.inputsLength; i++) {
		for (const chain of [0, 1] as const) {
			for (let idx = 0; idx < 5; idx++) {
				try {
					tx.signIdx(root.derive("m/48'/0'/0'/2'").deriveChild(chain).deriveChild(idx).privateKey!, i);
				} catch {
					/* not our key at this path */
				}
			}
		}
	}
	return base64.encode(tx.toPSBT());
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

function singleWallet(seed: number): { wallet: Wallet; root: HDKey } {
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(seed));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	const wallet = importWallet(userId, { name: 'S', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	return { wallet, root };
}

function multisigWallet(seeds: number[], threshold: number): { wallet: Wallet; roots: HDKey[] } {
	const roots = seeds.map((s) => HDKey.fromMasterSeed(new Uint8Array(32).fill(s)));
	const cos = roots.map((r) => ({
		xpub: r.derive("m/48'/0'/0'/2'").publicExtendedKey,
		fingerprint: hex.encode(u32(r.fingerprint)),
		path: "m/48'/0'/0'/2'"
	}));
	const wallet = importWallet(userId, { name: 'V', cosigners: cos, threshold, scriptType: 'p2wsh' });
	return { wallet, roots };
}

describe('T7: the one broadcast path (both kinds reach the same rail)', () => {
	it('single-sig: build -> sign -> broadcast reaches node.broadcast once', async () => {
		const { wallet, root } = singleWallet(3);
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5
		});
		const signed = signSingle(built.psbtBase64, root);
		const node = spyNode();
		const res = await broadcastDraft(node, userId, wallet.id, built.draftId, signed);
		expect(res.duplicate).toBe(false);
		expect(res.txid).toMatch(/^[0-9a-f]{64}$/);
		expect(node.calls.length).toBe(1);
	});

	it('multisig: two cosigners -> broadcast reaches the SAME rail once', async () => {
		const { wallet, roots } = multisigWallet([1, 2, 3], 2);
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5
		});
		const sig1 = applySignature(userId, wallet.id, built.draftId, signMultisig(built.psbtBase64, roots[0]));
		expect(sig1.progress.collected).toBe(1);
		expect(sig1.progress.complete).toBe(false);
		const sig2 = applySignature(userId, wallet.id, built.draftId, signMultisig(built.psbtBase64, roots[1]));
		expect(sig2.progress.collected).toBe(2);
		expect(sig2.progress.complete).toBe(true);

		const node = spyNode();
		const res = await broadcastDraft(node, userId, wallet.id, built.draftId);
		expect(res.duplicate).toBe(false);
		expect(node.calls.length).toBe(1);
	});

	it('four concurrent broadcasts of one draft -> one send, three AlreadyBroadcastError', async () => {
		const { wallet, root } = singleWallet(4);
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5
		});
		// Fully sign the draft first so all four callers can finalize.
		applySignature(userId, wallet.id, built.draftId, signSingle(built.psbtBase64, root));

		const node = spyNode();
		const results = await Promise.allSettled(
			[0, 1, 2, 3].map(() => broadcastDraft(node, userId, wallet.id, built.draftId))
		);
		const fulfilled = results.filter((r) => r.status === 'fulfilled' && !(r.value as { duplicate: boolean }).duplicate);
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(node.calls.length).toBe(1);
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(3);
		for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyBroadcastError);
	});

	it('refuses a rail that reports a forged txid (anti-forgery)', async () => {
		const { wallet, root } = singleWallet(5);
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5
		});
		applySignature(userId, wallet.id, built.draftId, signSingle(built.psbtBase64, root));
		const liar = spyNode('ff'.repeat(32));
		await expect(broadcastDraft(liar, userId, wallet.id, built.draftId)).rejects.toThrow(WalletError);
	});

	it('RBF: two bumps replacing the same txid -> one succeeds, one AlreadyReplacedError', async () => {
		const { wallet } = singleWallet(6);
		// Two coins so the second bump can select a coin and reach the RBF guard
		// (the first bump reserves the first coin).
		const a0 = deriveAddresses(wallet, 0, 0, 1)[0];
		const a1 = deriveAddresses(wallet, 0, 1, 1)[0];
		const map = new Map([
			[a0.scripthash, 'c0'.repeat(32)],
			[a1.scripthash, 'c1'.repeat(32)]
		]);
		const node: BuildNode = {
			tipHeight: 800100,
			electrum: {
				async batchRequest(items) {
					return items.map((it) => {
						const s = it.params[0] as string;
						const t = map.get(s);
						if (it.method === 'blockchain.scripthash.get_history')
							return t ? [{ tx_hash: t, height: 800000 }] : [];
						return t ? { confirmed: 1_000_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
					});
				},
				async listUnspent(scripthash) {
					const t = map.get(scripthash);
					return t ? [{ tx_hash: t, tx_pos: 0, value: 1_000_000, height: 800000 }] : [];
				},
				async getTransaction(t) {
					return { txid: t, vin: [], vout: [] };
				}
			}
		};
		const replaced = 'dd'.repeat(32);
		await buildPsbt(node, userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5,
			replacesTxid: replaced
		});
		await expect(
			buildPsbt(node, userId, wallet.id, {
				recipients: [{ address: RECIP, amountSats: 100_000 }],
				feeRate: 8,
				replacesTxid: replaced
			})
		).rejects.toThrow(AlreadyReplacedError);
	});
});
