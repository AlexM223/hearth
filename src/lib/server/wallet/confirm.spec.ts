/**
 * T9: SPV confirm path wired end-to-end. A broadcast draft advances to
 * `confirmed` ONLY on a valid inclusion proof (real block-700000 vector); a bad
 * proof leaves it `broadcast` (fail closed -- no false positive).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { confirmDraft, type ConfirmNode } from './confirm.js';
import { getDraftRow } from './repo.js';

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

function goodNode(): ConfirmNode {
	return {
		async getMerkleProof() {
			return { block_height: V.height, merkle: V.merkle, pos: V.pos };
		},
		async getBlockHeader() {
			return V.headerHex;
		}
	};
}
function liarNode(): ConfirmNode {
	return {
		async getMerkleProof() {
			return { block_height: V.height, merkle: ['ff'.repeat(32), ...V.merkle.slice(1)], pos: V.pos };
		},
		async getBlockHeader() {
			return V.headerHex;
		}
	};
}

let walletId: number;
let draftId: number;
beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('a', 'h', 'owner');
	const userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	db.prepare('INSERT INTO wallets (user_id, name, kind, script_type, network) VALUES (?, ?, ?, ?, ?)').run(
		userId,
		'w',
		'single',
		'p2wpkh',
		'mainnet'
	);
	walletId = Number((db.prepare('SELECT id FROM wallets').get() as { id: number }).id);
	db.prepare(
		`INSERT INTO psbt_drafts (wallet_id, created_by, status, psbt, txid, recipients, amount_sats, fee_sats, fee_rate, expires_at)
		 VALUES (?, ?, 'broadcast', 'psbt', ?, '[]', 0, 0, 1, '2099-01-01T00:00:00.000Z')`
	).run(walletId, userId, V.txid);
	draftId = Number((db.prepare('SELECT id FROM psbt_drafts').get() as { id: number }).id);
});

describe('T9: confirm path (SPV-verified, fail closed)', () => {
	it('advances a broadcast draft to confirmed on a valid proof', async () => {
		const res = await confirmDraft(goodNode(), walletId, draftId, V.height, { tipHeight: 800000 });
		expect(res).toEqual({ ok: true });
		expect(getDraftRow(walletId, draftId)!.status).toBe('confirmed');
	});

	it('leaves the draft broadcast on a bad merkle proof (no false positive)', async () => {
		const res = await confirmDraft(liarNode(), walletId, draftId, V.height, { tipHeight: 800000 });
		expect(res.ok).toBe(false);
		expect(getDraftRow(walletId, draftId)!.status).toBe('broadcast');
	});

	it('refuses (weak_target) and does not confirm when the difficulty floor is violated', async () => {
		const res = await confirmDraft(goodNode(), walletId, draftId, V.height, { tipHeight: 800000, maxTarget: 1n });
		expect(res).toEqual({ ok: false, reason: 'weak_target' });
		expect(getDraftRow(walletId, draftId)!.status).toBe('broadcast');
	});
});
