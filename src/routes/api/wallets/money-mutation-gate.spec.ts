/**
 * hearth-xum: route-level boundary regression for the mutating money
 * endpoints that route-gate.spec.ts (T8) didn't cover -- broadcast, abandon,
 * receive, and build (POST drafts). Same helpers/db setup as
 * route-gate.spec.ts and sign-role-gate.spec.ts: calls the REAL +server.ts
 * handlers, a "member-other" (an authenticated member who owns a DIFFERENT
 * wallet, or none at all) gets the uniform 404 (no leak, WALLET-ENGINE
 * §5.3), and a Guest gets 403 at the org-role floor (COME-ABOARD §3.3)
 * before the ownership check even runs. Each case also asserts NO state
 * change -- the mutation genuinely never ran, not just "returned an error".
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, getDraft, listDrafts, getWallet, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';

const broadcastDraftMock = vi.fn();
vi.mock('$lib/server/wallet/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/wallet/index.js')>();
	return { ...actual, broadcastDraft: (...args: unknown[]) => (broadcastDraftMock(...args), actual.broadcastDraft(...(args as Parameters<typeof actual.broadcastDraft>))) };
});

import { POST as broadcastRoute } from './[id]/drafts/[draftId]/broadcast/+server.js';
import { POST as abandonRoute } from './[id]/drafts/[draftId]/abandon/+server.js';
import { POST as receiveRoute } from './[id]/receive/+server.js';
import { POST as buildDraftRoute } from './[id]/drafts/+server.js';

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
function evt(
	userId: number | null,
	params: Record<string, string>,
	body: unknown,
	role: 'owner' | 'member' | 'guest' = 'member'
): any {
	return {
		locals: { user: userId == null ? null : { id: userId, username: 'u' + userId, role, mustResetPassword: false } },
		params,
		url: new URL('http://localhost/api/wallets'),
		request: { json: async () => body ?? {} }
	};
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

function assertNoLeak(payload: unknown, secrets: string[]): void {
	const s = JSON.stringify(payload ?? '');
	for (const secret of secrets) expect(s).not.toContain(secret);
}

let ownerId: number;
let otherId: number; // "member-other": an authenticated member who does NOT own this wallet
let wallet: Wallet;
let draftId: number;
let psbtSecret: string;

beforeEach(async () => {
	broadcastDraftMock.mockClear();
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('other', 'h', 'member');
	const rows = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
	ownerId = rows.find((r) => r.username === 'owner')!.id;
	otherId = rows.find((r) => r.username === 'other')!.id;

	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	wallet = importWallet(ownerId, { name: 'Spend', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), ownerId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 123_456 }],
		feeRate: 5
	});
	draftId = built.draftId;
	psbtSecret = built.psbtBase64;
});

describe('hearth-xum: POST .../broadcast boundary', () => {
	it('member-other => 404, no leak, and broadcastDraft is never called (no state change)', async () => {
		const body = await expectStatus(
			() => broadcastRoute(evt(otherId, { id: String(wallet.id), draftId: String(draftId) }, {})),
			404
		);
		assertNoLeak(body, [psbtSecret, RECIP, '123456']);
		expect(broadcastDraftMock).not.toHaveBeenCalled();
		expect(getDraft(wallet.id, draftId)!.status).toBe('draft');
	});

	it('Guest => 403 (org-role floor, before the ownership check runs), no state change', async () => {
		await expectStatus(
			() => broadcastRoute(evt(otherId, { id: String(wallet.id), draftId: String(draftId) }, {}, 'guest')),
			403
		);
		expect(broadcastDraftMock).not.toHaveBeenCalled();
		expect(getDraft(wallet.id, draftId)!.status).toBe('draft');
	});

	it('anon => 401', async () => {
		await expectStatus(() => broadcastRoute(evt(null, { id: String(wallet.id), draftId: String(draftId) }, {})), 401);
		expect(broadcastDraftMock).not.toHaveBeenCalled();
	});
});

describe('hearth-xum: POST .../abandon boundary', () => {
	it('member-other => 404, draft untouched', async () => {
		const body = await expectStatus(
			() => abandonRoute(evt(otherId, { id: String(wallet.id), draftId: String(draftId) }, {})),
			404
		);
		assertNoLeak(body, [psbtSecret, RECIP]);
		expect(getDraft(wallet.id, draftId)!.status).toBe('draft');
	});

	it('Guest => 403, draft untouched', async () => {
		await expectStatus(
			() => abandonRoute(evt(otherId, { id: String(wallet.id), draftId: String(draftId) }, {}, 'guest')),
			403
		);
		expect(getDraft(wallet.id, draftId)!.status).toBe('draft');
	});

	it('anon => 401', async () => {
		await expectStatus(() => abandonRoute(evt(null, { id: String(wallet.id), draftId: String(draftId) }, {})), 401);
	});

	it('regression guard: the actual owner CAN still abandon it', async () => {
		const body = (await expectStatus(
			() => abandonRoute(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) }, {}, 'owner')),
			200
		)) as { abandoned: boolean };
		expect(body.abandoned).toBe(true);
		expect(getDraft(wallet.id, draftId)!.status).toBe('abandoned');
	});
});

describe('hearth-xum: POST .../receive boundary', () => {
	it('member-other => 404, receiveCursor unchanged (nothing rotated)', async () => {
		const before = getWallet(ownerId, wallet.id)!.receiveCursor;
		const body = await expectStatus(() => receiveRoute(evt(otherId, { id: String(wallet.id) }, {})), 404);
		assertNoLeak(body, [RECIP]);
		expect(getWallet(ownerId, wallet.id)!.receiveCursor).toBe(before);
	});

	it('Guest => 403, receiveCursor unchanged', async () => {
		const before = getWallet(ownerId, wallet.id)!.receiveCursor;
		await expectStatus(() => receiveRoute(evt(otherId, { id: String(wallet.id) }, {}, 'guest')), 403);
		expect(getWallet(ownerId, wallet.id)!.receiveCursor).toBe(before);
	});

	it('anon => 401', async () => {
		await expectStatus(() => receiveRoute(evt(null, { id: String(wallet.id) }, {})), 401);
	});

	it('regression guard: the actual owner still gets a rotated address', async () => {
		const before = getWallet(ownerId, wallet.id)!.receiveCursor;
		const body = (await expectStatus(() => receiveRoute(evt(ownerId, { id: String(wallet.id) }, {}, 'owner')), 200)) as {
			index: number;
		};
		expect(body.index).toBe(before);
		expect(getWallet(ownerId, wallet.id)!.receiveCursor).toBe(before + 1);
	});
});

describe('hearth-xum: POST .../drafts (build PSBT) boundary', () => {
	it('member-other => 404, no leak, and no new draft is created', async () => {
		const before = listDrafts(wallet.id).length;
		const body = await expectStatus(
			() =>
				buildDraftRoute(
					evt(otherId, { id: String(wallet.id) }, { recipients: [{ address: RECIP, amountSats: 1000 }], feeRate: 5 })
				),
			404
		);
		assertNoLeak(body, [psbtSecret, RECIP]);
		expect(listDrafts(wallet.id).length).toBe(before);
	});

	it('Guest => 403, no new draft is created', async () => {
		const before = listDrafts(wallet.id).length;
		await expectStatus(
			() =>
				buildDraftRoute(
					evt(otherId, { id: String(wallet.id) }, { recipients: [{ address: RECIP, amountSats: 1000 }], feeRate: 5 }, 'guest')
				),
			403
		);
		expect(listDrafts(wallet.id).length).toBe(before);
	});

	it('anon => 401', async () => {
		await expectStatus(
			() => buildDraftRoute(evt(null, { id: String(wallet.id) }, { recipients: [{ address: RECIP, amountSats: 1000 }], feeRate: 5 })),
			401
		);
	});
});
