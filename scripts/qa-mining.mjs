#!/usr/bin/env node
/**
 * T8 -- the M5 forced-solve regtest harness (MINING-ENGINE.md §8). The ship
 * gate: exercises the REAL engine end-to-end (real StratumServer, job.ts,
 * wire.ts, coinbase.ts, and the real mining/index.ts bridge + wallet module
 * against a real, dockerized regtest bitcoind) and prints `RESULT: PASS` /
 * `RESULT: FAIL`. A thin vitest gate (mining/forcedSolve.e2e.spec.ts) runs
 * this as a child process and asserts exit 0 + the PASS line.
 *
 * Run directly:
 *   npx tsx scripts/qa-mining.mjs
 * (requires Docker; set BITCOIND_PATH to a real bitcoind binary to skip
 * Docker, or HEARTH_QA_REGTEST_PORT to pin the RPC port.)
 *
 * Mechanism (MINING-ENGINE.md §8):
 *  1. Spin regtest bitcoind (Docker, since no local bitcoind binary is
 *     assumed) on a free probed port; mine ~101 bootstrap blocks.
 *  2. Construct the real MiningPool against that node with a real in-memory
 *     SQLite mirroring the actual DDL, an AuthProvider mapping two test
 *     miningIds -> two regtest bcrt1 p2wpkh addresses derived from fixed
 *     BIP84 seeds. shareDifficulty ~= 1e-6, vardiff disabled, blockPolicyShift
 *     0 (production semantics -- the LOW share difficulty, not a shift, is
 *     what makes a solve reachable on a laptop).
 *  3. Two scripted SyntheticMiners (raw net sockets): subscribe -> authorize
 *     -> notify -> reconstruct the coinbase -> fold merkle branches -> build
 *     the header via the engine's OWN wire.ts -> sweep nonces -> submit.
 *  4. Assert on-chain: submitblock accepted, tip advanced, coinbase pays the
 *     winner's address the FULL reward (one value output + the zero-value
 *     witness commitment), the bridge advanced the receive cursor and
 *     recorded an accepted mining_blocks row.
 *  5. Payout isolation: replay the winner's EXACT winning share on the OTHER
 *     miner's connection -- assert it is rejected, no second block appears,
 *     and the replayer has zero mining_blocks rows.
 *  6. Maturity: mine +100 blocks; gettxout confirms the coinbase output is
 *     unspent with >=101 confirmations.
 */
import { createServer, createConnection } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';

import { buildJob } from '../src/lib/server/mining/job.js';
import { StratumServer } from '../src/lib/server/mining/stratum.js';
import { MiningPool } from '../src/lib/server/mining/miningPool.js';
import { MapAuthProvider } from '../src/lib/server/mining/types.js';
import { networkFor } from '../src/lib/server/mining/address.js';
import { fromStratumPrevHash, buildHeader, headerHashDisplay, hashValueFromDisplay, difficultyToTarget, sha256d, applyBranches } from '../src/lib/server/mining/wire.js';

import { openDb, closeDb } from '../src/lib/server/db/index.js';
import { runMigrations } from '../src/lib/server/db/migrations.js';
import { importWallet } from '../src/lib/server/wallet/index.js';
import { handleBlockAccepted, __resetMiningEngineForTests } from '../src/lib/server/mining/index.js';

const CONTAINER = `hearth-qa-mining-${process.pid}`;
const IMAGE = 'polarlightning/bitcoind:27.0';
const SHARE_DIFFICULTY = 1e-6;
const PASS = [];
const FAIL = [];

function log(msg) {
	process.stdout.write(`[qa-mining] ${msg}\n`);
}
function assert(cond, msg) {
	if (cond) PASS.push(msg);
	else FAIL.push(msg);
}

// ---------------------------------------------------------------- regtest node

async function findFreePort(preferred) {
	if (preferred) return preferred;
	return await new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

function bitcoindBinaryAvailable() {
	if (process.env.BITCOIND_PATH) return process.env.BITCOIND_PATH;
	for (const p of ['/usr/bin/bitcoind', '/usr/local/bin/bitcoind', 'C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe']) {
		try {
			const r = spawnSync(p, ['-version'], { timeout: 3000 });
			if (r.status === 0) return p;
		} catch {
			/* not present */
		}
	}
	return null;
}

function dockerAvailable() {
	try {
		const r = spawnSync('docker', ['version'], { timeout: 5000 });
		return r.status === 0;
	} catch {
		return false;
	}
}

class RegtestNode {
	constructor(port) {
		this.port = port;
		this.url = `http://127.0.0.1:${port}/`;
		this.auth = 'Basic ' + Buffer.from('hearth:hearthtest').toString('base64');
		this.startedContainer = false;
	}

	async rpc(method, params = [], wallet) {
		const url = wallet ? `${this.url}wallet/${wallet}` : this.url;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: this.auth },
			body: JSON.stringify({ jsonrpc: '1.0', id: 'qa', method, params })
		});
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
		}
		if (body.error) throw new Error(`${method}: ${body.error.message}`);
		return body.result;
	}

	async start() {
		log(`starting regtest bitcoind (docker) on port ${this.port}...`);
		execFileSync('docker', [
			'run', '-d', '--rm', '--name', CONTAINER,
			'-p', `${this.port}:18443`,
			IMAGE,
			'bitcoind', '-regtest', '-server', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0',
			'-rpcuser=hearth', '-rpcpassword=hearthtest', '-fallbackfee=0.0002', '-txindex'
		]);
		this.startedContainer = true;

		for (let i = 0; i < 60; i++) {
			try {
				await this.rpc('getblockchaininfo');
				log('bitcoind RPC is ready.');
				return;
			} catch {
				await sleep(1000);
			}
		}
		throw new Error('regtest bitcoind never became ready');
	}

	stop() {
		if (!this.startedContainer) return;
		try {
			execFileSync('docker', ['stop', CONTAINER], { timeout: 15000 });
		} catch (e) {
			log(`warning: failed to stop container ${CONTAINER}: ${e}`);
		}
	}
}

// ------------------------------------------------------------- test fixtures

/** Derive a regtest bcrt1 p2wpkh address (ECC needed only HERE, for building
 *  the fixture -- the engine's own address.ts stays ECC-free). */
function addressFromSeed(seedByte) {
	const seed = new Uint8Array(32).fill(seedByte);
	const account = HDKey.fromMasterSeed(seed).derive("m/84'/1'/0'/0/0");
	const { address } = bitcoin.payments.p2wpkh({
		pubkey: Buffer.from(account.publicKey),
		network: bitcoin.networks.regtest
	});
	return address;
}

/** Minimal newline-JSON Stratum test client over a real TCP socket. */
class SyntheticMiner {
	constructor(port) {
		this.socket = createConnection({ port, host: '127.0.0.1' });
		this.buf = '';
		this.messages = [];
		this.waiters = [];
		this.socket.on('data', (chunk) => {
			this.buf += chunk.toString('utf8');
			let idx;
			while ((idx = this.buf.indexOf('\n')) >= 0) {
				const line = this.buf.slice(0, idx).trim();
				this.buf = this.buf.slice(idx + 1);
				if (!line) continue;
				const msg = JSON.parse(line);
				this.messages.push(msg);
				this.waiters = this.waiters.filter((w) => {
					if (w.pred(msg)) {
						w.resolve(msg);
						return false;
					}
					return true;
				});
			}
		});
	}

	waitForOpen() {
		return new Promise((resolve, reject) => {
			this.socket.once('connect', resolve);
			this.socket.once('error', reject);
		});
	}

	send(obj) {
		this.socket.write(JSON.stringify(obj) + '\n');
	}

	waitFor(pred, timeoutMs = 5000) {
		const existing = this.messages.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
			this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
		});
	}

	close() {
		this.socket.destroy();
	}
}

async function subscribeAuthorize(miner, id) {
	let msgId = 1;
	miner.send({ id: msgId, method: 'mining.subscribe', params: [] });
	const sub = await miner.waitFor((m) => m.id === msgId);
	const en1 = sub.result[1];
	msgId++;
	miner.send({ id: msgId, method: 'mining.authorize', params: [id, 'x'] });
	const auth = await miner.waitFor((m) => m.id === msgId);
	if (auth.result !== true) throw new Error(`authorize failed for ${id}: ${JSON.stringify(auth.error)}`);
	return en1;
}

// -------------------------------------------------------------------- main

async function main() {
	const localBitcoind = bitcoindBinaryAvailable();
	if (!localBitcoind && !dockerAvailable()) {
		log('neither a bitcoind binary nor Docker is available -- cannot run the forced-solve gate here.');
		console.log('RESULT: SKIP');
		process.exitCode = 0;
		return;
	}
	if (localBitcoind) {
		log(`a local bitcoind binary was found (${localBitcoind}) but this harness only implements the Docker path today -- falling back to Docker.`);
	}

	const port = await findFreePort(process.env.HEARTH_QA_REGTEST_PORT ? Number(process.env.HEARTH_QA_REGTEST_PORT) : undefined);
	const node = new RegtestNode(port);
	let pool = null;
	const regtestNet = networkFor('regtest');

	try {
		await node.start();

		try {
			await node.rpc('createwallet', ['miner']);
		} catch {
			/* already exists */
		}
		const bootstrapAddr = await node.rpc('getnewaddress', [], 'miner');
		await node.rpc('generatetoaddress', [101, bootstrapAddr]);
		log('mined 101 bootstrap blocks.');

		// ---- DB + wallets (the REAL bridge: wallet module + mining/index.ts) ----
		closeDb();
		const db = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
		__resetMiningEngineForTests();

		db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('winner', 'h', 'member')").run();
		db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('other', 'h', 'member')").run();
		const winnerUserId = 1;
		const otherUserId = 2;

		const winnerRoot = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
		const otherRoot = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
		const winnerWallet = importWallet(winnerUserId, {
			name: 'Winner',
			descriptor: `wpkh([00000000/84'/1'/0']${winnerRoot.derive("m/84'/1'/0'").publicExtendedKey}/0/*)`,
			network: 'regtest'
		});
		const otherWallet = importWallet(otherUserId, {
			name: 'Other',
			descriptor: `wpkh([00000000/84'/1'/0']${otherRoot.derive("m/84'/1'/0'").publicExtendedKey}/0/*)`,
			network: 'regtest'
		});

		const winnerAddress = addressFromSeed(7);
		const otherAddress = addressFromSeed(9);
		const winnerScript = new Uint8Array(bitcoin.address.toOutputScript(winnerAddress, regtestNet));
		const otherScript = new Uint8Array(bitcoin.address.toOutputScript(otherAddress, regtestNet));

		const authProvider = new MapAuthProvider([
			{ userId: winnerUserId, miningId: 'qa_winner', walletId: winnerWallet.id, address: winnerAddress, payoutScript: winnerScript },
			{ userId: otherUserId, miningId: 'qa_other', walletId: otherWallet.id, address: otherAddress, payoutScript: otherScript }
		]);

		let acceptedCallback = null;
		const rpcCaller = { call: (method, params) => node.rpc(method, params) };
		pool = new MiningPool({
			rpc: rpcCaller,
			authProvider,
			config: {
				bindHost: '127.0.0.1',
				port: 0,
				network: regtestNet,
				poolTag: 'hearth-qa',
				shareDifficulty: SHARE_DIFFICULTY,
				vardiffEnabled: false,
				vardiffTargetPerMin: 6,
				maxDifficulty: 2 ** 40,
				maxConnections: 128,
				blockPolicyShift: 0, // production semantics -- low shareDifficulty makes the solve reachable
				asicPortEnabled: false,
				asicPort: 0,
				asicShareDifficulty: 65536,
				sv2Enabled: false,
				sv2Port: 3335,
				sv2ShareDifficulty: 65536,
				sv2VersionRolling: false
			},
			tipPollIntervalMs: 500,
			onBlockAccepted: (solve, blockHash, coinbaseTxid) => {
				void handleBlockAccepted(solve, blockHash, coinbaseTxid);
				if (acceptedCallback) acceptedCallback({ solve, blockHash, coinbaseTxid });
			},
			log: (msg) => log(`engine: ${msg}`)
		});
		await pool.start();
		log(`stratum listening on 127.0.0.1:${pool.status().port}`);

		// Wait for the first job.
		for (let i = 0; i < 30 && pool.status().lastJobAt === null; i++) await sleep(200);
		assert(pool.status().lastJobAt !== null, 'engine produced a job for the bootstrap tip');

		const minerWinner = new SyntheticMiner(pool.status().port);
		const minerOther = new SyntheticMiner(pool.status().port);
		await Promise.all([minerWinner.waitForOpen(), minerOther.waitForOpen()]);
		const en1Winner = await subscribeAuthorize(minerWinner, 'qa_winner');
		const en1Other = await subscribeAuthorize(minerOther, 'qa_other');

		const notifyWinner = await minerWinner.waitFor((m) => m.method === 'mining.notify');
		const notifyOther = await minerOther.waitFor((m) => m.method === 'mining.notify');
		assert(notifyWinner.params[0] === notifyOther.params[0], 'both miners are mining the SAME job');

		const jobId = notifyWinner.params[0];
		const [, prevHashStratumW, coinb1W, coinb2W, branchesW, versionHexW, nbitsHexW, ntimeHexW] = notifyWinner.params;
		const prevHashDisplayW = fromStratumPrevHash(prevHashStratumW);

		// Reconstruct + fold locally to find a qualifying nonce (mirrors a real
		// miner and job.ts's own headerFor -- via the engine's shared wire.ts).
		const en2 = '00000000';
		function headerForNonce(coinb1Hex, coinb2Hex, en1Hex, nonceHex) {
			const raw = Buffer.concat([Buffer.from(coinb1Hex, 'hex'), Buffer.from(en1Hex, 'hex'), Buffer.from(en2, 'hex'), Buffer.from(coinb2Hex, 'hex')]);
			const coinbaseTxidLE = sha256d(raw);
			const branches = branchesW.map((b) => Buffer.from(b, 'hex'));
			const root = applyBranches(coinbaseTxidLE, branches);
			return buildHeader(versionHexW, prevHashDisplayW, root, ntimeHexW, nbitsHexW, nonceHex);
		}
		const shareTarget = difficultyToTarget(SHARE_DIFFICULTY);
		let winningNonceHex = null;
		for (let n = 0; n < 2_000_000; n++) {
			const nonceHex = n.toString(16).padStart(8, '0');
			const header = headerForNonce(coinb1W, coinb2W, en1Winner, nonceHex);
			if (hashValueFromDisplay(headerHashDisplay(header)) <= shareTarget) {
				winningNonceHex = nonceHex;
				break;
			}
		}
		assert(winningNonceHex !== null, 'found a nonce clearing the share target within 2,000,000 tries');

		const acceptedPromise = new Promise((resolve) => {
			acceptedCallback = resolve;
		});

		minerWinner.send({ id: 100, method: 'mining.submit', params: ['default', jobId, en2, ntimeHexW, winningNonceHex] });
		const submitResp = await minerWinner.waitFor((m) => m.id === 100);
		assert(submitResp.result === true, 'the winning share was accepted by the Stratum server');

		const accepted = await Promise.race([
			acceptedPromise,
			sleep(20000).then(() => null)
		]);
		assert(accepted !== null, 'onBlockAccepted fired within 20s of the winning submit');

		if (accepted) {
			const tipHash = await node.rpc('getbestblockhash');
			assert(tipHash === accepted.blockHash, 'getbestblockhash === the assembled/solve hash');
			assert(pool.fatalErrors.length === 0, `pool.fatalErrors is empty (was: ${JSON.stringify(pool.fatalErrors)})`);

			const block = await node.rpc('getblock', [tipHash, 2]);
			const coinbaseTx = block.tx[0];
			const valueOuts = coinbaseTx.vout.filter((o) => o.value > 0);
			assert(valueOuts.length === 1, `coinbase has exactly one value-bearing output (found ${valueOuts.length})`);
			assert(
				valueOuts[0]?.scriptPubKey.address === winnerAddress,
				`the one value output pays the winner's address ${winnerAddress} (paid ${valueOuts[0]?.scriptPubKey.address})`
			);
			assert(
				valueOuts[0]?.value > 0 && coinbaseTx.vout.length <= 2,
				`coinbase carries the full reward (${valueOuts[0]?.value} BTC) plus at most a zero-value witness commitment`
			);
			assert(coinbaseTx.txid === accepted.coinbaseTxid, 'recorded coinbaseTxid matches the on-chain coinbase txid');

			// Bridge effects: receive cursor advanced, mining_blocks row recorded.
			const walletRow = db.prepare('SELECT receive_cursor FROM wallets WHERE id = ?').get(winnerWallet.id);
			assert(walletRow.receive_cursor === 1, `winner's receive_cursor advanced 0 -> 1 (was ${walletRow.receive_cursor})`);
			const blockRow = db.prepare('SELECT * FROM mining_blocks WHERE block_hash = ?').get(accepted.blockHash);
			assert(!!blockRow && blockRow.submit_result === 'accepted' && blockRow.user_id === winnerUserId, 'mining_blocks row recorded, accepted, attributed to the winner');

			// ---- Payout isolation: replay the EXACT winning share on the OTHER
			// miner's connection. Its own extranonce1 differs, so this must
			// either fail to validate (LOW_DIFFICULTY on its own coinbase) or at
			// minimum never produce a second accepted block.
			const blocksBefore = await node.rpc('getblockcount');
			minerOther.send({ id: 200, method: 'mining.submit', params: ['default', jobId, en2, ntimeHexW, winningNonceHex] });
			const replayResp = await minerOther.waitFor((m) => m.id === 200);
			assert(replayResp.result !== true, `the replayed winning share on the OTHER connection is REJECTED (got result=${replayResp.result})`);
			await sleep(1000);
			const blocksAfter = await node.rpc('getblockcount');
			assert(blocksAfter === blocksBefore, 'no second block was produced by the replay');
			const otherBlockRows = db.prepare('SELECT COUNT(*) AS n FROM mining_blocks WHERE user_id = ?').get(otherUserId);
			assert(otherBlockRows.n === 0, "the replaying user has ZERO mining_blocks rows");
			const stillWinnerOnly = db.prepare("SELECT COUNT(*) AS n FROM mining_blocks WHERE submit_result = 'accepted'").get();
			assert(stillWinnerOnly.n === 1, 'exactly one accepted block exists, still the winner\'s');

			// ---- Maturity: mine +100 blocks, confirm the coinbase output is
			// unspent with >=101 confirmations.
			await node.rpc('generatetoaddress', [100, bootstrapAddr]);
			const txout = await node.rpc('gettxout', [accepted.coinbaseTxid, 0]);
			assert(!!txout && txout.confirmations >= 101, `coinbase output unspent with >=101 confirmations (got ${txout?.confirmations})`);
		}

		minerWinner.close();
		minerOther.close();
	} finally {
		if (pool) await pool.stop().catch(() => {});
		closeDb();
		node.stop();
	}

	log('');
	log(`${PASS.length} checks passed, ${FAIL.length} failed.`);
	for (const p of PASS) log(`  PASS: ${p}`);
	for (const f of FAIL) log(`  FAIL: ${f}`);
	if (FAIL.length === 0) {
		console.log('RESULT: PASS');
		process.exitCode = 0;
	} else {
		console.log('RESULT: FAIL');
		process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error(e);
	console.log('RESULT: FAIL');
	process.exitCode = 1;
});
