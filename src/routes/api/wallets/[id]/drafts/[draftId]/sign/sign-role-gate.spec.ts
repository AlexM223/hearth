/**
 * T6 acceptance (SIGNING.md §2.4, §5.4): the role gate on /sign. Widening to
 * "owner OR assigned cosigner" is explicitly gated on M3's resolveWalletRole
 * returning cosigner roles (M2 returns only 'owner'/'viewer'/'none') --
 * until then this pins /sign as owner-only, with a non-owner refused a
 * uniform 404 that leaks no PSBT/recipient/amount (assertNoLeak). A
 * regression here is exactly the "the gate existed but the route never
 * called it" class WALLET-ENGINE §5.3 was written to prevent.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { POST as signRoute } from './+server.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(userId: number | null, params: Record<string, string>, body: unknown, role: 'owner' | 'guest' | 'member' = 'guest'): any {
	return {
		locals: { user: userId == null ? null : { id: userId, username: 'u' + userId, role, mustResetPassword: false } },
		params,
		request: { json: async () => body }
	};
}

function assertNoLeak(payload: unknown, secrets: string[]): void {
	const s = JSON.stringify(payload ?? '');
	for (const secret of secrets) expect(s).not.toContain(secret);
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		if (res instanceof Response) {
			expect(res.status).toBe(status);
			return await res.json();
		}
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		const err = e as { status?: number; body?: { message?: string } };
		expect(err.status).toBe(status);
		return err.body;
	}
}

let ownerId: number;
let outsiderId: number;
let wallet: Wallet;
let draftId: number;
let psbtSecret: string;

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('outsider', 'h', 'member');
	const rows = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
	ownerId = rows.find((r) => r.username === 'owner')!.id;
	outsiderId = rows.find((r) => r.username === 'outsider')!.id;

	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	wallet = importWallet(ownerId, { name: 'Spend', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), ownerId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 123_456 }],
		feeRate: 5
	});
	draftId = built.draftId;
	psbtSecret = built.psbtBase64;
});

describe('T6: /sign is owner-only until M3 (SIGNING.md §2.4)', () => {
	it('a non-owner (even an authenticated member with no relation to this wallet) gets 404, no leak', async () => {
		const body = await expectStatus(
			() => signRoute(evt(outsiderId, { id: String(wallet.id), draftId: String(draftId) }, { psbt: 'irrelevant' }, 'member')),
			404
		);
		assertNoLeak(body, [psbtSecret, RECIP, '123456']);
	});

	it('an unauthenticated caller gets 401 on /sign', async () => {
		await expectStatus(() => signRoute(evt(null, { id: String(wallet.id), draftId: String(draftId) }, { psbt: 'irrelevant' })), 401);
	});

	it('the owner is still accepted through to the validation layer (regression guard on the gate above)', async () => {
		// Resubmitting the draft's OWN unsigned bytes trivially satisfies the
		// commitment check (same transaction) and returns 200 with zero
		// signatures collected -- the point here is the ROLE gate lets the
		// owner through to that layer at all, unlike the outsider's 404 above.
		const body = (await expectStatus(
			() => signRoute(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) }, { psbt: psbtSecret })),
			200
		)) as { progress: { collected: number } };
		expect(body.progress.collected).toBe(0); // no real signature was ever attached
	});

	it('a hostile-sized payload is refused before the owner-gate even matters', async () => {
		await expectStatus(
			() => signRoute(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) }, { psbt: 'A'.repeat(700_001) })),
			400
		);
	});
});
