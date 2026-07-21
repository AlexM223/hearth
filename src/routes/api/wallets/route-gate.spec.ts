/**
 * T8 route-level viewer-boundary regression (WALLET-ENGINE §5.3, §6.4). Calls
 * the ACTUAL +server.ts handlers (not just the service gate) and asserts a
 * non-owner gets a uniform 404 whose body leaks NONE of the PSBT base64,
 * recipient, or amount (assertNoLeak), while the owner gets the PSBT. Heartwood's
 * bug was "the gate existed but the route never called it" -- this pins it.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { GET as getDraft } from './[id]/drafts/[draftId]/+server.js';
import { GET as listDrafts } from './[id]/drafts/+server.js';
import { GET as walletDetail } from './[id]/+server.js';

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
function evt(userId: number | null, params: Record<string, string>, body?: unknown): any {
	return {
		locals: { user: userId == null ? null : { id: userId, username: 'u' + userId, role: 'guest', mustResetPassword: false } },
		params,
		request: { json: async () => body }
	};
}

/** Assert a value (status/body) leaks none of the given secret strings. */
function assertNoLeak(payload: unknown, secrets: string[]): void {
	const s = JSON.stringify(payload ?? '');
	for (const secret of secrets) expect(s).not.toContain(secret);
}

async function expectStatus(fn: () => unknown, status: number): Promise<unknown> {
	try {
		const res = await fn();
		// A returned Response (200 path) -- surface its JSON for assertions.
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
let viewerId: number;
let wallet: Wallet;
let draftId: number;
let psbtSecret: string;

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('guest', 'h', 'guest');
	const rows = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
	ownerId = rows.find((r) => r.username === 'owner')!.id;
	viewerId = rows.find((r) => r.username === 'guest')!.id;

	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(3));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	wallet = importWallet(ownerId, { name: 'Spend', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), ownerId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 123_456 }],
		feeRate: 5
	});
	draftId = built.draftId;
	psbtSecret = built.psbtBase64;
});

describe('T8: route-level viewer boundary', () => {
	it('owner GET draft-by-id returns 200 with the PSBT', async () => {
		const body = await expectStatus(
			() => getDraft(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) })),
			200
		);
		expect((body as { psbt: string }).psbt).toBe(psbtSecret);
	});

	it('non-owner GET draft-by-id => 404 leaking NO psbt/recipient/amount', async () => {
		const body = await expectStatus(
			() => getDraft(evt(viewerId, { id: String(wallet.id), draftId: String(draftId) })),
			404
		);
		assertNoLeak(body, [psbtSecret, RECIP, '123456', '123,456']);
	});

	it('non-owner GET drafts list => 404, no leak', async () => {
		const body = await expectStatus(() => listDrafts(evt(viewerId, { id: String(wallet.id) })), 404);
		assertNoLeak(body, [psbtSecret, RECIP, '123456']);
	});

	it('owner drafts list => 200 summaries that never include the raw psbt', async () => {
		const body = (await expectStatus(() => listDrafts(evt(ownerId, { id: String(wallet.id) })), 200)) as {
			drafts: unknown[];
		};
		expect(body.drafts.length).toBe(1);
		assertNoLeak(body.drafts, [psbtSecret]); // summaries omit psbt bytes
	});

	it('non-owner GET wallet detail => 404, no leak', async () => {
		const body = await expectStatus(() => walletDetail(evt(viewerId, { id: String(wallet.id) })), 404);
		assertNoLeak(body, [psbtSecret, RECIP]);
	});

	it('an unauthenticated caller => 401 on a PSBT route', async () => {
		await expectStatus(() => getDraft(evt(null, { id: String(wallet.id), draftId: String(draftId) })), 401);
	});
});
