/**
 * T6 acceptance (MINING-ENGINE.md §9.3): the engine starts only when all
 * three gates hold (feature flag, operator setting, Core RPC reachable to
 * determine the network); an unreachable/unsupported-chain Core refuses to
 * start and records a fatal instead of guessing; block-accepted wires the
 * receive-cursor advance, the mining_blocks row, and both notify() calls;
 * every lifecycle function is safe to call when nothing is running.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { importWallet } from '../wallet/index.js';
import { writeMiningSetting } from './settings.js';
import type { SolveEvent } from './types.js';

const state = vi.hoisted(() => ({
	handler: null as ((method: string, params?: unknown[]) => Promise<unknown>) | null
}));
// Preserve every REAL export (getBlockchainInfo etc -- mining/index.ts imports
// that from this same module) and override only getNodeClient, so the fatal-
// on-unreachable-Core and network-detection paths still run their real code
// against the fake coreRpc.call handler below.
vi.mock('../node/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../node/index.js')>();
	return {
		...actual,
		getNodeClient: () => ({
			coreRpc: {
				call: (method: string, params?: unknown[]) => state.handler!(method, params)
			}
		})
	};
});

// Imported AFTER the mock is declared so the mocked module resolves first.
const {
	startMiningEngine,
	stopMiningEngine,
	reconfigureMiningEngine,
	miningEngineRunning,
	miningFatalErrors,
	miningEngineStatus,
	handleBlockAccepted,
	networkForCoreChain,
	__resetMiningEngineForTests
} = await import('./index.js');

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

let userId: number;

function regtestHandler(overrides: Partial<Record<string, unknown>> = {}) {
	return async (method: string, params?: unknown[]): Promise<unknown> => {
		switch (method) {
			case 'getblockchaininfo':
				return overrides.getblockchaininfo ?? { chain: 'regtest', blocks: 100, initialblockdownload: false };
			case 'getbestblockhash':
				return overrides.getbestblockhash ?? 'aa'.repeat(32);
			case 'getblock':
				return { height: 100 };
			case 'getblocktemplate':
				return (
					overrides.getblocktemplate ?? {
						version: 0x20000000,
						previousblockhash: 'aa'.repeat(32),
						height: 101,
						curtime: Math.floor(Date.now() / 1000),
						bits: '207fffff',
						coinbasevalue: 5_000_000_000,
						transactions: []
					}
				);
			case 'submitblock':
				return null;
			case 'getnetworkhashps':
				return 1000;
			default:
				throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
		}
	};
}

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('a', 'h', 'member')").run();
	userId = Number((db.prepare('SELECT id FROM users').get() as { id: number }).id);
	__resetMiningEngineForTests();
	state.handler = regtestHandler();
	delete process.env.HEARTH_FEATURE_MINING;
});

afterEach(async () => {
	await stopMiningEngine();
});

describe('mining/index: networkForCoreChain', () => {
	it('maps Core chain names to ChainNetwork', () => {
		expect(networkForCoreChain('main')).toBe('mainnet');
		expect(networkForCoreChain('test')).toBe('testnet');
		expect(networkForCoreChain('testnet4')).toBe('testnet');
		expect(networkForCoreChain('regtest')).toBe('regtest');
	});

	it('refuses signet and unknown chains (returns null)', () => {
		expect(networkForCoreChain('signet')).toBeNull();
		expect(networkForCoreChain('bogus')).toBeNull();
	});
});

describe('mining/index: three-gate start sequence', () => {
	it('does NOT start when the feature flag is off', async () => {
		process.env.HEARTH_FEATURE_MINING = '0';
		writeMiningSetting('mining_enabled', true);
		await startMiningEngine();
		expect(miningEngineRunning()).toBe(false);
	});

	it('does NOT start when the operator setting is off (default)', async () => {
		await startMiningEngine();
		expect(miningEngineRunning()).toBe(false);
	});

	it('refuses to start (records a fatal) when Core RPC is unreachable — never guesses a network', async () => {
		writeMiningSetting('mining_enabled', true);
		state.handler = async (method) => {
			if (method === 'getblockchaininfo') throw new Error('ECONNREFUSED');
			throw new Error(`unexpected ${method}`);
		};
		await startMiningEngine();
		expect(miningEngineRunning()).toBe(false);
		expect(miningFatalErrors().some((m) => /could not reach Bitcoin Core RPC/.test(m))).toBe(true);
	});

	it('refuses to start on an unsupported chain (e.g. signet)', async () => {
		writeMiningSetting('mining_enabled', true);
		state.handler = regtestHandler({ getblockchaininfo: { chain: 'signet', blocks: 1, initialblockdownload: false } });
		await startMiningEngine();
		expect(miningEngineRunning()).toBe(false);
		expect(miningFatalErrors().some((m) => /does not support/.test(m))).toBe(true);
	});

	it('starts when all three gates hold, against a real (loopback, port 0) Stratum listener', async () => {
		writeMiningSetting('mining_enabled', true);
		writeMiningSetting('mining_stratum_port', 0);
		writeMiningSetting('mining_asic_port_enabled', false);
		await startMiningEngine();
		expect(miningEngineRunning()).toBe(true);
		expect(miningEngineStatus().engine?.listening).toBe(true);
	});

	it('startMiningEngine is idempotent — calling twice concurrently shares one in-flight start', async () => {
		writeMiningSetting('mining_enabled', true);
		writeMiningSetting('mining_stratum_port', 0);
		writeMiningSetting('mining_asic_port_enabled', false);
		await Promise.all([startMiningEngine(), startMiningEngine()]);
		expect(miningEngineRunning()).toBe(true);
	});
});

describe('mining/index: lifecycle safety (never throws)', () => {
	it('stopMiningEngine is safe to call when nothing is running', async () => {
		await expect(stopMiningEngine()).resolves.toBeUndefined();
	});

	it('reconfigureMiningEngine is safe when nothing is running and gates are closed', async () => {
		await expect(reconfigureMiningEngine()).resolves.toBeUndefined();
		expect(miningEngineRunning()).toBe(false);
	});
});

describe('mining/index: handleBlockAccepted wires all effects', () => {
	function solveFor(wallet: { id: number }): SolveEvent {
		return {
			jobId: 'j1',
			extranonce1Hex: 'aabbccdd',
			extranonce2Hex: '00000000',
			ntimeHex: '5f5e1000',
			nonceHex: '00000000',
			hashDisplay: '00'.repeat(32),
			height: 900,
			userId,
			miningId: 'hearth_test',
			worker: 'rig1',
			walletId: wallet.id,
			address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
			payoutScriptHex: '0014' + '00'.repeat(20),
			coinbaseValueSats: 5_000_000_000n
		};
	}

	it('advances the receive cursor, records the block row, and fires both notify() calls', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		const before = getDb().prepare('SELECT receive_cursor FROM wallets WHERE id = ?').get(wallet.id) as {
			receive_cursor: number;
		};

		await handleBlockAccepted(solveFor(wallet), 'bb'.repeat(32), 'cc'.repeat(32));

		const after = getDb().prepare('SELECT receive_cursor FROM wallets WHERE id = ?').get(wallet.id) as {
			receive_cursor: number;
		};
		expect(after.receive_cursor).toBe(before.receive_cursor + 1);

		const block = getDb().prepare('SELECT * FROM mining_blocks WHERE block_hash = ?').get('bb'.repeat(32)) as {
			submit_result: string;
			user_id: number;
			height: number;
		};
		expect(block.submit_result).toBe('accepted');
		expect(block.user_id).toBe(userId);
		expect(block.height).toBe(900);

		const events = getDb().prepare("SELECT * FROM events WHERE type = 'mining_block_found'").all() as {
			user_id: number | null;
			level: string;
		}[];
		expect(events).toHaveLength(2); // one user-scoped success + one broadcast info
		expect(events.some((e) => e.user_id === userId && e.level === 'success')).toBe(true);
		expect(events.some((e) => e.user_id === null && e.level === 'info')).toBe(true);
	});

	it('never throws even when the wallet/foreign key is bad (invariant 4 -- a mining failure must never crash the app)', async () => {
		const bogusSolve: SolveEvent = { ...solveFor({ id: 999_999 }), userId: 999_999 };
		await expect(handleBlockAccepted(bogusSolve, 'dd'.repeat(32), 'ee'.repeat(32))).resolves.toBeUndefined();
	});

	it('a duplicate block_hash callback is swallowed, not thrown', async () => {
		const wallet = importWallet(userId, { name: 'W', xpub: ZPUB });
		await handleBlockAccepted(solveFor(wallet), 'ff'.repeat(32), 'aa'.repeat(32));
		await expect(handleBlockAccepted(solveFor(wallet), 'ff'.repeat(32), 'aa'.repeat(32))).resolves.toBeUndefined();
	});
});
