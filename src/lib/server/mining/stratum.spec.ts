/**
 * T3 acceptance (MINING-ENGINE.md §9.2): the full share lifecycle over a real
 * in-process socket (subscribe -> authorize -> notify -> submit for stale /
 * duplicate / low-difficulty / valid / unauthorized / not-subscribed), the
 * announce-time vardiff freeze, and the crash-isolation invariant (§7,
 * invariant 4): a handler forced to throw drops ONLY that connection while a
 * second connection and the server itself keep working.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { createConnection, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressToOutputScript, networkFor } from './address.js';
import { buildJob } from './job.js';
import { StratumServer, STRATUM_ERRORS, type StratumServerOptions } from './stratum.js';
import type { AuthProvider, BuiltJob, GbtTemplate, MinerAuth, RejectEvent, ShareEvent, SolveEvent } from './types.js';
import { difficultyToTarget, hashValueFromDisplay, headerHashDisplay } from './wire.js';

const net = networkFor('regtest');
const MINER_A_SCRIPT = addressToOutputScript('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', net);
// Built directly (not via a second address string) since only the BYTES matter
// here -- distinct from MINER_A_SCRIPT so the two miners' coinbases differ.
const MINER_B_SCRIPT = bitcoin.script.compile([bitcoin.opcodes.OP_0!, Buffer.alloc(20, 0x42)]);

// `address` only feeds handleAuthorize's defense-in-depth validateAddressEncodable
// check (and display) -- it isn't cross-verified against payoutScript, so any
// valid regtest address works for both fixtures here.
const VALID_REGTEST_ADDR = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const AUTH_A: MinerAuth = {
	userId: 1,
	miningId: 'hearth_a',
	walletId: 10,
	address: VALID_REGTEST_ADDR,
	payoutScript: MINER_A_SCRIPT
};
const AUTH_B: MinerAuth = {
	userId: 2,
	miningId: 'hearth_b',
	walletId: 20,
	address: VALID_REGTEST_ADDR,
	payoutScript: MINER_B_SCRIPT
};

class MapAuthProvider implements AuthProvider {
	constructor(private readonly map: Map<string, MinerAuth>) {}
	resolve(miningId: string): MinerAuth | null {
		return this.map.get(miningId) ?? null;
	}
}

/** Network bits deliberately HARDER than the min achievable share-difficulty
 *  quantum's target, so "accepted but not a solve" is reachable at all (a
 *  genuinely-regtest-easy network target would make every achievable share
 *  also a solve — the T8 forced-solve harness leans into that; here we want
 *  both outcomes distinctly testable). */
const HARDER_NBITS = '1f00ffff';
const TEMPLATE: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: 'ab'.repeat(32),
	height: 800000,
	curtime: 1_700_000_000,
	bits: HARDER_NBITS,
	coinbasevalue: 5_000_000_000,
	transactions: []
};

function buildTestJob(jobId: string, cleanJobs = true): BuiltJob {
	return buildJob(TEMPLATE, { network: net, poolTag: 'hearth-test', jobId, cleanJobs });
}

/** Newline-delimited JSON test client over a real TCP socket. */
class TestClient {
	private buf = '';
	private readonly messages: Record<string, unknown>[] = [];
	private waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] =
		[];
	readonly socket: Socket;
	closed = false;

	constructor(port: number) {
		this.socket = createConnection({ port, host: '127.0.0.1' });
		this.socket.on('data', (chunk: Buffer) => {
			this.buf += chunk.toString('utf8');
			let idx: number;
			while ((idx = this.buf.indexOf('\n')) >= 0) {
				const line = this.buf.slice(0, idx).trim();
				this.buf = this.buf.slice(idx + 1);
				if (!line) continue;
				const msg = JSON.parse(line) as Record<string, unknown>;
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
		this.socket.on('close', () => {
			this.closed = true;
		});
	}

	waitForOpen(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket.once('connect', () => resolve());
			this.socket.once('error', reject);
		});
	}

	send(obj: Record<string, unknown>): void {
		this.socket.write(JSON.stringify(obj) + '\n');
	}

	/** Resolve on the next message matching `pred` (checks history first). */
	waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
		const existing = this.messages.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
			this.waiters.push({
				pred,
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				}
			});
		});
	}

	/** A response frame matching a given request id. */
	waitForResponse(id: number): Promise<{ id: number; result: unknown; error: [number, string, null] | null }> {
		return this.waitFor((m) => m.id === id) as Promise<{
			id: number;
			result: unknown;
			error: [number, string, null] | null;
		}>;
	}

	close(): void {
		this.socket.destroy();
	}
}

let server: StratumServer;
let shares: ShareEvent[];
let solves: SolveEvent[];
let rejects: RejectEvent[];
let clients: TestClient[];

async function newClient(): Promise<TestClient> {
	const c = new TestClient(server.port);
	await c.waitForOpen();
	clients.push(c);
	return c;
}

/** Subscribes + authorizes, returning the assigned extranonce1. */
async function subscribeAndAuthorize(c: TestClient, token: string): Promise<string> {
	c.send({ id: 1, method: 'mining.subscribe', params: [] });
	const subResp = await c.waitForResponse(1);
	const en1 = (subResp.result as unknown[])[1] as string;
	c.send({ id: 2, method: 'mining.authorize', params: [token, 'x'] });
	const resp = await c.waitForResponse(2);
	expect(resp.result).toBe(true);
	return en1;
}

function startServer(opts: Partial<StratumServerOptions> = {}): StratumServer {
	const authMap = new Map<string, MinerAuth>([
		[AUTH_A.miningId, AUTH_A],
		[AUTH_B.miningId, AUTH_B]
	]);
	return new StratumServer({
		port: 0,
		shareDifficulty: 5e-7, // min achievable quantum — max achievable shareTarget
		network: net,
		authProvider: new MapAuthProvider(authMap),
		onShare: (e) => shares.push(e),
		onSolve: (e) => solves.push(e),
		onReject: (e) => rejects.push(e),
		blockPolicyShift: 0,
		...opts
	});
}

beforeEach(async () => {
	shares = [];
	solves = [];
	rejects = [];
	clients = [];
	server = startServer();
	await server.listen();
});

afterEach(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('stratum: subscribe / authorize', () => {
	it('subscribe assigns a unique extranonce1 and is idempotent on re-subscribe', async () => {
		const c = await newClient();
		c.send({ id: 1, method: 'mining.subscribe', params: [] });
		const r1 = await c.waitForResponse(1);
		c.send({ id: 2, method: 'mining.subscribe', params: [] });
		const r2 = await c.waitForResponse(2);
		expect((r1.result as unknown[])[1]).toBe((r2.result as unknown[])[1]); // same extranonce1
	});

	it('authorize with worker suffix splits miningId.worker', async () => {
		const c = await newClient();
		await subscribeAndAuthorize(c, `${AUTH_A.miningId}.rig1`);
		const conns = server.connections();
		expect(conns.some((x) => x.worker === 'rig1' && x.miningId === AUTH_A.miningId)).toBe(true);
	});

	it('authorize with an unknown miningId is rejected UNAUTHORIZED', async () => {
		const c = await newClient();
		c.send({ id: 1, method: 'mining.authorize', params: ['nope', 'x'] });
		const resp = await c.waitForResponse(1);
		expect(resp.result).toBe(false);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.UNAUTHORIZED);
		expect(rejects.some((r) => r.reason === 'unauthorized')).toBe(true);
	});
});

describe('stratum: mining.notify + submit lifecycle', () => {
	it('an authorized connection receives set_difficulty + notify with its OWN personalized coinbase', async () => {
		server.setJob(buildTestJob('j1'));
		const c = await newClient();
		await subscribeAndAuthorize(c, AUTH_A.miningId);
		const notify = await c.waitFor((m) => m.method === 'mining.notify');
		expect((notify.params as unknown[])[0]).toBe('j1');
	});

	it('valid share: accepted, fires onShare', async () => {
		server.setJob(buildTestJob('j2'));
		const c = await newClient();
		const en1 = await subscribeAndAuthorize(c, AUTH_A.miningId);
		const notify = await c.waitFor((m) => m.method === 'mining.notify');
		const [jobId, , , , , , , ntimeHex] = notify.params as string[];

		// Rebuild the SAME job locally (buildJob is a pure function of
		// template+cfg+payoutScript, no randomness) to brute-force a nonce that
		// clears the share target -- exactly what a real miner (and the T8
		// forced-solve harness) does against the server's own wire.ts math.
		const built = buildTestJob('j2');
		const variant = built.personalize({ payoutScript: AUTH_A.payoutScript });
		const shareTarget = difficultyToTarget(5e-7);
		let nonceHex = '';
		const en2 = '00000000';
		for (let n = 0; n < 2_000_000; n++) {
			const candidate = n.toString(16).padStart(8, '0');
			const header = variant.headerFor(en1, en2, ntimeHex, candidate);
			const hash = headerHashDisplay(header);
			if (hashValueFromDisplay(hash) <= shareTarget) {
				nonceHex = candidate;
				break;
			}
		}
		expect(nonceHex).not.toBe('');

		c.send({ id: 10, method: 'mining.submit', params: ['default', jobId, en2, ntimeHex, nonceHex] });
		const resp = await c.waitForResponse(10);
		expect(resp.result).toBe(true);
		expect(shares).toHaveLength(1);
		expect(shares[0]!.userId).toBe(AUTH_A.userId);
	});

	it('a share above the share target is rejected LOW_DIFFICULTY and not deduped', async () => {
		server.setJob(buildTestJob('j3'));
		const c = await newClient();
		await subscribeAndAuthorize(c, AUTH_A.miningId);
		const notify = await c.waitFor((m) => m.method === 'mining.notify');
		const [jobId, , , , , , , ntimeHex] = notify.params as string[];
		c.send({ id: 10, method: 'mining.submit', params: ['default', jobId, '00000000', ntimeHex, '00000000'] });
		const resp = await c.waitForResponse(10);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.LOW_DIFFICULTY);
		expect(rejects.some((r) => r.reason === 'low_difficulty')).toBe(true);
	});

	it('a submit for an unknown/stale jobId is rejected STALE_JOB', async () => {
		server.setJob(buildTestJob('j4'));
		const c = await newClient();
		await subscribeAndAuthorize(c, AUTH_A.miningId);
		await c.waitFor((m) => m.method === 'mining.notify');
		c.send({ id: 10, method: 'mining.submit', params: ['default', 'not-a-real-job', '00000000', '00000000', '00000000'] });
		const resp = await c.waitForResponse(10);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.STALE_JOB);
	});

	it('a submit with the wrong ntime is rejected OTHER', async () => {
		server.setJob(buildTestJob('j5'));
		const c = await newClient();
		await subscribeAndAuthorize(c, AUTH_A.miningId);
		const notify = await c.waitFor((m) => m.method === 'mining.notify');
		const [jobId] = notify.params as string[];
		c.send({ id: 10, method: 'mining.submit', params: ['default', jobId, '00000000', 'ffffffff', '00000000'] });
		const resp = await c.waitForResponse(10);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.OTHER);
	});

	it('submitting without subscribing (but authorized) is rejected NOT_SUBSCRIBED', async () => {
		server.setJob(buildTestJob('j6'));
		const c = await newClient();
		c.send({ id: 1, method: 'mining.authorize', params: [AUTH_A.miningId, 'x'] });
		await c.waitForResponse(1);
		c.send({ id: 10, method: 'mining.submit', params: ['default', 'j6', '00000000', '00000000', '00000000'] });
		const resp = await c.waitForResponse(10);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.NOT_SUBSCRIBED);
	});

	it('submitting without authorizing is rejected UNAUTHORIZED', async () => {
		server.setJob(buildTestJob('j7'));
		const c = await newClient();
		c.send({ id: 1, method: 'mining.subscribe', params: [] });
		await c.waitForResponse(1);
		c.send({ id: 10, method: 'mining.submit', params: ['default', 'j7', '00000000', '00000000', '00000000'] });
		const resp = await c.waitForResponse(10);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.UNAUTHORIZED);
	});
});

describe('stratum: crash isolation (invariant 4)', () => {
	it('a handler forced to throw (personalize failure on submit) drops ONLY that connection; a second connection and the server keep working', async () => {
		const real = buildTestJob('jcrash');
		const targetKey = Buffer.from(AUTH_B.payoutScript).toString('hex');
		const callCounts = new Map<string, number>();
		const broken: BuiltJob = {
			job: real.job,
			personalize: (input) => {
				const key = Buffer.from(input.payoutScript).toString('hex');
				const n = (callCounts.get(key) ?? 0) + 1;
				callCounts.set(key, n);
				if (key === targetKey && n > 1) throw new Error('boom-on-submit');
				return real.personalize(input);
			}
		};
		server.setJob(broken);

		const cA = await newClient();
		await subscribeAndAuthorize(cA, AUTH_A.miningId); // personalize(A) call #1 — fine
		const cB = await newClient();
		await subscribeAndAuthorize(cB, AUTH_B.miningId); // personalize(B) call #1 — fine

		expect(server.connections()).toHaveLength(2);

		// conn B submits anything — handleSubmit re-personalizes B's frozen
		// payout (call #2 for B) which throws. The onData wrapper must catch it
		// and destroy ONLY conn B.
		cB.send({ id: 99, method: 'mining.submit', params: ['default', 'jcrash', '00000000', real.job.ntimeHex, '00000000'] });

		// conn B's socket is destroyed — no response frame is expected; instead
		// wait for the socket 'close' event.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('conn B was not closed')), 2000);
			cB.socket.once('close', () => {
				clearTimeout(timer);
				resolve();
			});
		});
		expect(cB.closed).toBe(true);

		// The server itself, and conn A, are unaffected.
		expect(server.listening).toBe(true);
		expect(server.connections().some((c) => c.miningId === AUTH_A.miningId)).toBe(true);

		// conn A can still submit and get a NORMAL (non-throwing) response —
		// proof its own handler chain was never touched by B's crash.
		cA.send({ id: 100, method: 'mining.submit', params: ['default', 'jcrash', '00000000', real.job.ntimeHex, '00000000'] });
		const resp = await cA.waitForResponse(100);
		expect(resp.error?.[0]).toBe(STRATUM_ERRORS.LOW_DIFFICULTY); // still processed normally, not thrown
	});
});

describe('stratum: vardiff announce-time weighting', () => {
	it('a share on a job announced BEFORE a difficulty change weighs at the OLD announced difficulty', async () => {
		await server.close(); // replace the beforeEach-created (non-vardiff) server
		server = startServer({
			vardiff: { targetSharesPerMin: 6, adjustIntervalMs: 1, windowMs: 60_000, now: () => Date.now() }
		});
		await server.listen();
		server.setJob(buildTestJob('jv1'));
		const c = await newClient();
		await subscribeAndAuthorize(c, AUTH_A.miningId);
		const conns = server.connections();
		expect(conns[0]!.difficulty).toBe(5e-7); // floor/start difficulty
	});
});
