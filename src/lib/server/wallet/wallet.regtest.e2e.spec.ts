/**
 * Regtest broadcast e2e (WALLET-ENGINE §6.2). Gated on HEARTH_E2E=1. Drives a
 * REAL build -> external-sign -> broadcast -> confirm through Hearth's OWN
 * modules against a dockerized regtest bitcoind (no parallel re-impl). Proves:
 *  - a Hearth-derived address's scriptPubKey === Core's for the same descriptor
 *  - buildPsbt selects a real funded coin and constructs a valid PSBT
 *  - broadcastDraft (the ONE path) produces a tx bitcoind ACCEPTS
 *  - the locally-recomputed txid matches the network txid
 *  - verifyTxInclusion returns {ok:true} for the mined block; draft -> confirmed
 *
 * Setup (run once):
 *   docker run -d --name hearth-regtest -p 18443:18443 polarlightning/bitcoind:27.0 \
 *     bitcoind -regtest -server -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
 *     -rpcuser=hearth -rpcpassword=hearthtest -fallbackfee=0.0002 -txindex
 *   HEARTH_E2E=1 npx vitest run src/lib/server/wallet/wallet.regtest.e2e.spec.ts
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { base64, hex, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from './import.js';
import { buildPsbt, applySignature, type BuildNode } from './psbt.js';
import { broadcastDraft } from './broadcast.js';
import { confirmDraft } from './confirm.js';
import { getDraftRow } from './repo.js';
import { deriveAddresses } from './index.js';
import { scriptToScripthash } from './derive.js';
import type { Wallet } from './types.js';

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
		'\n[wallet.regtest.e2e] SKIPPED. To run:\n' +
			'  docker run -d --name hearth-regtest -p 18443:18443 polarlightning/bitcoind:27.0 \\\n' +
			'    bitcoind -regtest -server -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -rpcuser=hearth -rpcpassword=hearthtest -fallbackfee=0.0002 -txindex\n' +
			'  HEARTH_E2E=1 npx vitest run src/lib/server/wallet/wallet.regtest.e2e.spec.ts\n\n'
	);
}

describe.skipIf(!E2E)('regtest e2e: single-sig one broadcast path', () => {
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(42));
	const account = root.derive("m/84'/0'/0'");
	let wallet: Wallet;
	let userId: number;
	let coinTxid: string;
	let coinVout: number;
	let coinSats: number;

	beforeAll(async () => {
		closeDb();
		const db: DatabaseSync = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
		db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'owner');
		userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);

		wallet = importWallet(userId, {
			name: 'RegtestSingle',
			descriptor: `wpkh([00000000/84'/0'/0']${account.publicExtendedKey}/0/*)`,
			network: 'regtest'
		});

		// Mining wallet on Core.
		try {
			await rpc('createwallet', ['miner']);
		} catch {
			/* already exists */
		}
		const minerAddr = await rpc<string>('getnewaddress', [], 'miner');
		await rpc('generatetoaddress', [101, minerAddr]);

		// Fund the Hearth-derived receive address 0/0.
		const recv = deriveAddresses(wallet, 0, 0, 1)[0];
		coinTxid = await rpc<string>('sendtoaddress', [recv.address, 5], 'miner');
		await rpc('generatetoaddress', [1, minerAddr]);
		// Find the vout paying us.
		const raw = await rpc<{ vout: { value: number; n: number; scriptPubKey: { hex: string } }[] }>(
			'getrawtransaction',
			[coinTxid, true]
		);
		const ours = raw.vout.find((v) => v.scriptPubKey.hex === recv.scriptPubKey);
		coinVout = ours!.n;
		coinSats = Math.round(ours!.value * 1e8);
	}, 60_000);

	it('Hearth-derived address matches Core for the same descriptor', async () => {
		const recv = deriveAddresses(wallet, 0, 0, 1)[0];
		// Core-on-regtest validates the key version byte, so hand it a tpub (same
		// key, testnet/regtest version) -- both must derive the identical bcrt1 addr.
		const tpub = toTpub(account.publicExtendedKey);
		const desc = (
			await rpc<{ descriptor: string }>('getdescriptorinfo', [
				`wpkh([00000000/84'/1'/0']${tpub}/0/*)`
			])
		).descriptor;
		const info = await rpc<string[]>('deriveaddresses', [desc, [0, 0]]);
		expect(recv.address).toBe(info[0]);
	});

	it('builds, externally signs, broadcasts (ONE path), and confirms via SPV', async () => {
		const recv = deriveAddresses(wallet, 0, 0, 1)[0];
		const sh = scriptToScripthash(hex.decode(recv.scriptPubKey));

		// A Core-backed rail: utxos come from the real regtest coin.
		const rail: BuildNode['electrum'] = {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history')
						return s === sh ? [{ tx_hash: coinTxid, height: 102 }] : [];
					return s === sh ? { confirmed: coinSats, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh
					? [{ tx_hash: coinTxid, tx_pos: coinVout, value: coinSats, height: 102 }]
					: [];
			},
			async getTransaction(txid, verbose) {
				const raw = await rpc<string | object>('getrawtransaction', [txid, verbose ? true : false]);
				return raw;
			}
		};
		const node: BuildNode = { electrum: rail, tipHeight: 102 };

		const dest = await rpc<string>('getnewaddress', [], 'miner');
		const built = await buildPsbt(node, userId, wallet.id, {
			recipients: [{ address: dest, amountSats: 100_000 }],
			feeRate: 2
		});
		expect(built.review.inputs.length).toBeGreaterThan(0);

		// External signing with the seed's child key (the server never holds it).
		const signedTx = btc.Transaction.fromPSBT(base64.decode(built.psbtBase64));
		for (let i = 0; i < signedTx.inputsLength; i++) {
			signedTx.signIdx(account.deriveChild(0).deriveChild(0).privateKey!, i);
		}
		const signedPsbt = base64.encode(signedTx.toPSBT());

		// THE one broadcast path -> real regtest bitcoind.
		const broadcastNode = { broadcast: (rawHex: string) => rpc<string>('sendrawtransaction', [rawHex]) };
		const result = await broadcastDraft(broadcastNode, userId, wallet.id, built.draftId, signedPsbt);
		expect(result.duplicate).toBe(false);
		expect(result.txid).toMatch(/^[0-9a-f]{64}$/);

		// bitcoind accepted it: it's in the mempool.
		const mempool = await rpc<string[]>('getrawmempool', []);
		expect(mempool).toContain(result.txid);

		// Mine it, then SPV-verify inclusion and confirm the draft.
		const minerAddr = await rpc<string>('getnewaddress', [], 'miner');
		const [blockHash] = await rpc<string[]>('generatetoaddress', [1, minerAddr]);
		const block = await rpc<{ height: number; tx: string[] }>('getblock', [blockHash, 1]);
		const headerHex = await rpc<string>('getblockheader', [blockHash, false]);

		const confirmNode = {
			async getMerkleProof(txid: string) {
				const { branch, pos } = merkleBranch(block.tx, txid);
				return { block_height: block.height, merkle: branch, pos };
			},
			async getBlockHeader() {
				return headerHex;
			}
		};
		const spv = await confirmDraft(confirmNode, wallet.id, built.draftId, block.height, {
			tipHeight: block.height
		});
		expect(spv).toEqual({ ok: true });
		expect(getDraftRow(wallet.id, built.draftId)!.status).toBe('confirmed');
	}, 60_000);
});

/** Re-version a standard xpub to a tpub (swap BIP-32 version bytes). */
function toTpub(xpub: string): string {
	const b58c = base58check(sha256);
	const payload = new Uint8Array(b58c.decode(xpub));
	payload[0] = 0x04;
	payload[1] = 0x35;
	payload[2] = 0x87;
	payload[3] = 0xcf; // tpub
	return b58c.encode(payload);
}

/** Build a merkle branch (display-order hex) + position for a txid in a block. */
function merkleBranch(txids: string[], target: string): { branch: string[]; pos: number } {
	const sha256d = (b: Uint8Array): Uint8Array => Uint8Array.from(sha256(sha256(b)));
	let layer: Uint8Array[] = txids.map((t) => Uint8Array.from(hex.decode(t)).reverse()); // internal order
	let index = txids.indexOf(target);
	const branch: string[] = [];
	while (layer.length > 1) {
		if (layer.length % 2 === 1) layer = [...layer, layer[layer.length - 1]];
		const sibling = index % 2 === 0 ? layer[index + 1] : layer[index - 1];
		branch.push(hex.encode(Uint8Array.from(sibling).reverse())); // display order
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
