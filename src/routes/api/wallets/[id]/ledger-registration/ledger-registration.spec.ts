/**
 * T4: the Ledger BIP-388 registration seam route (SIGNING.md §1.1). Owner
 * scoped; validates the fingerprint/HMAC shapes; round-trips a saved
 * registration; an upsert on the same (wallet, masterFp) replaces rather
 * than duplicates.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { GET, POST } from './+server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(userId: number | null, params: Record<string, string>, body?: unknown, role: 'owner' | 'guest' | 'member' = 'owner'): any {
	return {
		locals: { user: userId == null ? null : { id: userId, username: 'u', role, mustResetPassword: false } },
		params,
		request: { json: async () => body }
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

let ownerId: number;
let viewerId: number;
let wallet: Wallet;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('guest', 'h', 'guest');
	const rows = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
	ownerId = rows.find((r) => r.username === 'owner')!.id;
	viewerId = rows.find((r) => r.username === 'guest')!.id;

	const a = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/48'/0'/0'/2'");
	const b = HDKey.fromMasterSeed(new Uint8Array(32).fill(2)).derive("m/48'/0'/0'/2'");
	wallet = importWallet(ownerId, {
		name: 'Vault',
		descriptor: `wsh(sortedmulti(2,[11111111/48'/0'/0'/2']${a.publicExtendedKey}/0/*,[22222222/48'/0'/0'/2']${b.publicExtendedKey}/0/*))`
	});
});

describe('GET/POST /api/wallets/[id]/ledger-registration', () => {
	it('GET starts empty', async () => {
		const body = (await expectStatus(() => GET(evt(ownerId, { id: String(wallet.id) })), 200)) as {
			registrations: unknown[];
		};
		expect(body.registrations).toEqual([]);
	});

	it('POST validates masterFp/policyHmac/policyName shapes', async () => {
		await expectStatus(() => POST(evt(ownerId, { id: String(wallet.id) }, { masterFp: 'nothex', policyHmac: 'a'.repeat(64), policyName: 'x' })), 400);
		await expectStatus(() => POST(evt(ownerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'tooshort', policyName: 'x' })), 400);
		await expectStatus(() => POST(evt(ownerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'a'.repeat(64), policyName: '' })), 400);
	});

	it('POST saves and GET reflects it; a second POST for the same masterFp upserts (no duplicate)', async () => {
		await expectStatus(
			() => POST(evt(ownerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'aa'.repeat(32), policyName: 'Vault A' })),
			201
		);
		type Listed = { registrations: { masterFp: string; policyHmac: string; policyName: string }[] };
		const body1 = (await expectStatus(() => GET(evt(ownerId, { id: String(wallet.id) })), 200)) as Listed;
		expect(body1.registrations.length).toBe(1);
		expect(body1.registrations[0].policyHmac).toBe('aa'.repeat(32));

		await expectStatus(
			() => POST(evt(ownerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'bb'.repeat(32), policyName: 'Vault A' })),
			201
		);
		const body2 = (await expectStatus(() => GET(evt(ownerId, { id: String(wallet.id) })), 200)) as Listed;
		expect(body2.registrations.length).toBe(1); // upsert, not a second row
		expect(body2.registrations[0].policyHmac).toBe('bb'.repeat(32));
	});

	it('a non-owner (member) is refused on both GET and POST', async () => {
		await expectStatus(() => GET(evt(viewerId, { id: String(wallet.id) }, undefined, 'member')), 404);
		await expectStatus(
			() => POST(evt(viewerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'aa'.repeat(32), policyName: 'x' }, 'member')),
			404
		);
	});

	it('a Guest is refused with 403 (org-role floor, before the ownership check even runs)', async () => {
		await expectStatus(() => GET(evt(viewerId, { id: String(wallet.id) }, undefined, 'guest')), 403);
		await expectStatus(
			() => POST(evt(viewerId, { id: String(wallet.id) }, { masterFp: '11111111', policyHmac: 'aa'.repeat(32), policyName: 'x' }, 'guest')),
			403
		);
	});

	it('an unauthenticated caller gets 401', async () => {
		await expectStatus(() => GET(evt(null, { id: String(wallet.id) })), 401);
	});
});
