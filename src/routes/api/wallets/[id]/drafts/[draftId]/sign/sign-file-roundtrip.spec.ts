/**
 * T1 acceptance (SIGNING.md build order): a real externally-signed `.psbt`
 * (built + signed with `@scure/btc-signer` here, standing in for a real
 * external signer) round-trips through `psbtFile.ts`'s upload-normalization
 * and the ACTUAL `/sign` route handler, and the returned progress shows
 * `complete: true` -- the send loop closes for a single-sig wallet with
 * ZERO device libraries loaded (psbtFile.ts imports nothing from
 * `@ledgerhq`/`@trezor`/`bbqr`). Also covers the §3.3 belt-and-braces
 * body-length gate with a friendly 400.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';
import { POST as signRoute } from './+server.js';
import { readSignedPsbtUpload, psbtBase64ToBytes, psbtFilename } from '$lib/hw/psbtFile.js';

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

/** Minimal Blob-shaped double for readSignedPsbtUpload -- no DOM in this
 *  vitest project. */
function blobOf(bytes: Uint8Array): Blob {
	return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Blob;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(userId: number, params: Record<string, string>, body: unknown): any {
	return {
		locals: { user: { id: userId, username: 'owner', role: 'owner', mustResetPassword: false } },
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
let wallet: Wallet;
let draftId: number;
let unsignedPsbt: string;
let root: HDKey;

beforeEach(async () => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	ownerId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;

	root = HDKey.fromMasterSeed(new Uint8Array(32).fill(3));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	wallet = importWallet(ownerId, { name: 'Spend', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), ownerId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 123_456 }],
		feeRate: 5
	});
	draftId = built.draftId;
	unsignedPsbt = built.psbtBase64;
});

describe('T1: sign-with-file round-trips through psbtFile.ts + the real /sign route', () => {
	it('psbtFile.ts imports zero device libraries (file signing needs none)', () => {
		const src = readFileSync(new URL('../../../../../../../lib/hw/psbtFile.ts', import.meta.url), 'utf8');
		expect(/@ledgerhq|@trezor|['"]bbqr['"]/.test(src)).toBe(false);
	});

	it('builds the expected download filename', () => {
		expect(psbtFilename(wallet.id, draftId)).toBe(`wallet-${wallet.id}-draft-${draftId}.psbt`);
	});

	it('a real externally-signed PSBT round-trips (download bytes -> sign -> upload -> /sign) and enables slide-to-send', async () => {
		// "Download": decode the server's base64 to bytes (what a browser would
		// write to a .psbt file).
		const downloadedBytes = psbtBase64ToBytes(unsignedPsbt);

		// External signer (standing in for Sparrow/Coldcard/etc): sign the raw
		// bytes with the wallet's own child keys.
		const signedBase64ForFile = signSingle(base64.encode(downloadedBytes), root);
		const signedBytes = psbtBase64ToBytes(signedBase64ForFile);

		// "Upload": the browser reads the signed .psbt file back.
		const normalized = await readSignedPsbtUpload(blobOf(signedBytes));
		expect(normalized).toBe(base64.encode(signedBytes)); // byte-identical re-encode

		const body = (await expectStatus(
			() => signRoute(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) }, { psbt: normalized })),
			200
		)) as { progress: { complete: boolean; collected: number; required: number } };

		expect(body.progress.complete).toBe(true);
		expect(body.progress.collected).toBe(1);
		expect(body.progress.required).toBe(1);
	});

	it('a base64-armored (text) upload also normalizes correctly', async () => {
		const signedBase64 = signSingle(unsignedPsbt, root);
		const armored = new TextEncoder().encode(signedBase64 + '\n');
		const normalized = await readSignedPsbtUpload(blobOf(armored));
		expect(normalized).toBe(signedBase64);
	});

	it('a non-PSBT upload throws a typed InvalidPsbtFileError', async () => {
		const { InvalidPsbtFileError } = await import('$lib/hw/psbtFile.js');
		await expect(readSignedPsbtUpload(blobOf(new TextEncoder().encode('not a psbt at all')))).rejects.toBeInstanceOf(
			InvalidPsbtFileError
		);
	});

	it('§3.3: a signed PSBT string over the length gate is refused with a friendly 400', async () => {
		const huge = 'A'.repeat(700_001);
		const responseBody = (await expectStatus(
			() => signRoute(evt(ownerId, { id: String(wallet.id), draftId: String(draftId) }, { psbt: huge })),
			400
		)) as { message: string };
		expect(responseBody.message).toMatch(/unexpectedly large/i);
	});
});
