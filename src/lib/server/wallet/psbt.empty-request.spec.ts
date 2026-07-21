/**
 * Regression test for hearth-5vw (UX sweep finding #3, High): an empty Send
 * form (no client-side required-field check existed) posted a plausible-
 * looking but garbage body -- `{ recipients: [{ address: '', amountSats: 0
 * }], feeRate: 5 }` (`Number('')` coerces the empty Amount field to `0`, not
 * `NaN` -- a genuinely non-numeric string like `Number('abc')` would be
 * `NaN`, but the empty-field case is `0`) -- to `POST /api/wallets/:id/drafts`.
 * Because `buildPsbt` validated the request only implicitly, deep inside
 * `selectCoins`/`decodeAddress` AFTER a live `syncWallet`/`resolveMinFeeRate`
 * node round trip, an unreachable node backend (Core RPC/Electrum down --
 * exactly this dev machine's state during the sweep) threw an untyped
 * network error FIRST, surfacing as the route's generic 500 ("something went
 * wrong") instead of a 400.
 *
 * `assertValidBuildRequest` (psbt.ts) now runs before the lock, before the
 * wallet lookup, and before any node call. This suite proves every malformed
 * shape -- including the sweep's exact repro -- throws a typed `WalletError`
 * (=> `httpStatusFor` maps it to 400 with a clean message) WITHOUT ever
 * touching the node, using a "poison" node that throws if any of its methods
 * are called.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet, buildPsbt, type BuildNode } from './index.js';
import type { Wallet } from './types.js';
import { httpStatusFor } from './errors.js';

const VALID_ADDR = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

/** A node whose every method throws if called -- proves a malformed request
 *  never reaches the network/DB rail at all (the exact gap this fix closes:
 *  previously an unreachable node's OWN error would win the race and surface
 *  as a 500 before validation ever got a chance to run). */
function poisonNode(): BuildNode {
	const boom = () => {
		throw new Error('poison node: should never be called for a malformed request');
	};
	return {
		tipHeight: null,
		get electrum(): never {
			throw new Error('poison node: electrum accessed for a malformed request');
		},
		getMinFeeRate: boom,
		fetchRawTx: boom
	} as unknown as BuildNode;
}

let userId: number;
let wallet: Wallet;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;

	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	wallet = importWallet(userId, { name: 'Spend', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });
});

async function expectValidation400(body: unknown): Promise<string> {
	try {
		await buildPsbt(poisonNode(), userId, wallet.id, body as never);
		throw new Error('expected buildPsbt to throw for a malformed request');
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		expect(status).toBe(400);
		expect(typeof message).toBe('string');
		expect(message.length).toBeGreaterThan(0);
		expect(message).not.toBe('something went wrong'); // the old generic 500 fallback
		return message;
	}
}

describe('hearth-5vw: an empty/malformed Send-form POST is a 400, never a 500, and never touches the node', () => {
	it('the sweep\'s exact repro -- empty address, amountSats: 0 from Number(\'\') -- is a clean 400', async () => {
		await expectValidation400({ recipients: [{ address: '', amountSats: Number('') }], feeRate: 5 });
	});

	it('a genuinely NaN amount (a non-numeric string coerced client-side) is also a clean 400', async () => {
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: Number('abc') }], feeRate: 5 });
	});

	it('a completely empty body ({}) is a clean 400', async () => {
		await expectValidation400({});
	});

	it('an empty recipients array is a clean 400', async () => {
		await expectValidation400({ recipients: [], feeRate: 5 });
	});

	it('a non-array recipients field is a clean 400', async () => {
		await expectValidation400({ recipients: 'not-an-array', feeRate: 5 });
	});

	it('a whitespace-only address is a clean 400', async () => {
		await expectValidation400({ recipients: [{ address: '   ', amountSats: 10_000 }], feeRate: 5 });
	});

	it('a valid address with an amount left as the empty-field default (0) is a clean 400', async () => {
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: Number('') }], feeRate: 5 });
	});

	it('a zero or negative amount is a clean 400 (not just NaN)', async () => {
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: 0 }], feeRate: 5 });
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: -1 }], feeRate: 5 });
	});

	it('a fractional amount is a clean 400 (amounts are integer sats)', async () => {
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: 100.5 }], feeRate: 5 });
	});

	it('a missing/zero/NaN fee rate is a clean 400', async () => {
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: 10_000 }] });
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: 10_000 }], feeRate: 0 });
		await expectValidation400({ recipients: [{ address: VALID_ADDR, amountSats: 10_000 }], feeRate: Number('') });
	});

	it('"max" send amounts are still accepted by the shape check (validated later against real UTXOs)', async () => {
		// Recipient shape is valid ('max' is a legal amountSats value) -- this
		// should pass assertValidBuildRequest and reach the poisoned node, which
		// is exactly what we want to confirm: the gate doesn't over-reject.
		await expect(buildPsbt(poisonNode(), userId, wallet.id, {
			recipients: [{ address: VALID_ADDR, amountSats: 'max' }],
			feeRate: 5
		})).rejects.toThrow(/poison node/);
	});
});
