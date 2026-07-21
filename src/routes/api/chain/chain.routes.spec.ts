/**
 * T6 acceptance (EXPLORER.md §6, §4.2): every `/api/chain/**` handler
 * responds 200 for a Guest session -- never 403 -- the inverse of
 * COME-ABOARD's leak lock, since this surface's whole point is to STAY open
 * to the least-privileged role (the shared instrument panel). Calls the
 * REAL +server.ts handlers with a mocked NodeClient (no live node/Electrum
 * required, per the house testing convention) so every read model actually
 * runs its real code path.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { openDb, closeDb, runMigrations } from '$lib/server/db/index.js';
import { clearAllCaches } from '$lib/server/chain/index.js';

const GENESIS_HEADER_HEX =
	'0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';

function coinbaseRawTx(txid: string) {
	return {
		txid,
		hash: txid,
		version: 2,
		size: 100,
		vsize: 100,
		weight: 400,
		locktime: 0,
		vin: [{ coinbase: 'ab', sequence: 0xffffffff }],
		vout: [{ value: 3.125, n: 0, scriptPubKey: { asm: '', hex: 'aa', address: 'bc1qminer', type: 'witness_v0_keyhash' } }],
		hex: '',
		blockhash: 'hash900000',
		confirmations: 1,
		blocktime: 1_700_000_000
	};
}

function fakeNode() {
	return {
		electrum: {
			isConnected: true,
			getBlockHeader: async () => GENESIS_HEADER_HEX,
			getBlockHeaders: async (_start: number, count: number) => ({
				hex: GENESIS_HEADER_HEX.repeat(Math.max(1, count)),
				count,
				max: 2016
			}),
			estimateFee: async () => 0.00002,
			getFeeHistogram: async () => [[10, 1000]] as [number, number][],
			getBalance: async () => ({ confirmed: 100_000, unconfirmed: 0 }),
			getHistory: async () => []
		},
		coreRpc: {
			call: vi.fn(async (method: string, params: unknown[] = []) => {
				switch (method) {
					case 'getblockhash':
						return 'hash' + params[0];
					case 'getblockheader':
						return { hash: params[0], height: 900_000, time: 1_700_000_000 };
					case 'getblock': {
						const [hash, verbosity] = params as [string, number];
						if (verbosity === 1) return { tx: ['coinbasetxid'] };
						return {
							hash,
							height: 900_000,
							time: 1_700_000_000,
							confirmations: 1,
							size: 1000,
							strippedsize: 900,
							weight: 3600,
							version: 1,
							versionHex: '00000001',
							merkleroot: 'merkle',
							nonce: 1,
							bits: '1d00ffff',
							difficulty: 1,
							chainwork: 'aa',
							tx: [coinbaseRawTx('coinbasetxid')]
						};
					}
					case 'getrawtransaction':
						return coinbaseRawTx(String(params[0]));
					case 'gettxout':
						return null;
					case 'getmempoolinfo':
						return { loaded: true, size: 10, bytes: 1000, usage: 1, total_fee: 0.0001, maxmempool: 1, mempoolminfee: 0.00001 };
					case 'estimatesmartfee':
						return { feerate: 0.00002, blocks: 6 };
					case 'scantxoutset':
						return { success: true, txouts: 0, height: 900_000, bestblock: 'x', unspents: [], total_amount: 0.001 };
					default:
						throw Object.assign(new Error(`no handler for ${method}`), { rpcCode: -5 });
				}
			}),
			scanTxOutSet: async () => ({ success: true, txouts: 0, height: 900_000, bestblock: 'x', unspents: [], total_amount: 0.001 })
		},
		getTipHeight: async () => 900_000
	};
}

// Preserve every REAL export (addressToScriptPubKey/addressToScriptHash etc
// -- chain/address.ts imports those from this same module) and override only
// getNodeClient, so the route handlers exercise their real read-model code
// with a fake node instead of a live one.
vi.mock('$lib/server/node/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/node/index.js')>();
	return { ...actual, getNodeClient: () => fakeNode() };
});

type Role = 'owner' | 'member' | 'guest' | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: Role, params: Record<string, string> = {}, url = 'http://localhost/api/chain/x'): any {
	return {
		locals: { user: role == null ? null : { id: 1, username: role ?? 'anon', role, mustResetPassword: false } },
		params,
		url: new URL(url),
		request: { json: async () => ({}) }
	};
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		const res = await fn();
		if (res instanceof Response) return res.status;
		throw new Error('handler returned a non-Response value');
	} catch (e) {
		return (e as { status: number }).status;
	}
}

const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	clearAllCaches();
});

describe('T6: every /api/chain/** handler stays Guest-readable (never 403)', () => {
	const ROLES: Role[] = ['owner', 'member', 'guest'];

	it('GET /api/chain/search?q=', async () => {
		const { GET } = await import('./search/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role, {}, 'http://localhost/api/chain/search?q=900000')));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null, {}, 'http://localhost/api/chain/search?q=900000')))).toBe(401);
	});

	it('GET /api/chain/blocks', async () => {
		const { GET } = await import('./blocks/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role)));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null)))).toBe(401);
	});

	it('GET /api/chain/blocks/:hash', async () => {
		const { GET } = await import('./blocks/[hash]/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role, { hash: 'abcabc' })));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null, { hash: 'abcabc' })))).toBe(401);
	});

	it('GET /api/chain/blocks/:hash/txs', async () => {
		const { GET } = await import('./blocks/[hash]/txs/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role, { hash: 'abcabc' })));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null, { hash: 'abcabc' })))).toBe(401);
	});

	it('GET /api/chain/tx/:txid', async () => {
		const { GET } = await import('./tx/[txid]/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role, { txid: 'deadbeef'.repeat(8) })));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null, { txid: 'deadbeef'.repeat(8) })))).toBe(401);
	});

	it('GET /api/chain/address/:address', async () => {
		const { GET } = await import('./address/[address]/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role, { address: ADDRESS })));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null, { address: ADDRESS })))).toBe(401);
	});

	it('GET /api/chain/mempool', async () => {
		const { GET } = await import('./mempool/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role)));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null)))).toBe(401);
	});

	it('GET /api/chain/fees', async () => {
		const { GET } = await import('./fees/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => GET(evt(role)));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => GET(evt(null)))).toBe(401);
	});

	it('POST /api/chain/refresh', async () => {
		const { POST } = await import('./refresh/+server.js');
		for (const role of ROLES) {
			const status = await statusOf(() => POST(evt(role)));
			expect(status, role ?? 'anon').toBe(200);
		}
		expect(await statusOf(() => POST(evt(null)))).toBe(401);
	});
});
