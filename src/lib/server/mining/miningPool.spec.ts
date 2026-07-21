/**
 * T4 acceptance (MINING-ENGINE.md §9.2): port-in-use fails start() cleanly
 * with no half-open engine, and an end-to-end solve (real StratumServer +
 * real job.ts, a fake Core RPC standing in for bitcoind) assembles and
 * verifies before submitblock, firing onBlockAccepted.
 */
import { createConnection, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { addressToOutputScript, networkFor } from './address.js';
import { MiningPool, type MiningPoolOptions } from './miningPool.js';
import type { AuthProvider, GbtTemplate, MinerAuth, MiningEngineConfig, SolveEvent } from './types.js';
import { headerHashDisplay, hashValueFromDisplay, difficultyToTarget } from './wire.js';

const net = networkFor('regtest');
const MINER_SCRIPT = addressToOutputScript('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', net);
const AUTH: MinerAuth = {
	userId: 7,
	miningId: 'hearth_solo',
	walletId: 70,
	address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
	payoutScript: MINER_SCRIPT
};
class OneMinerAuth implements AuthProvider {
	resolve(miningId: string): MinerAuth | null {
		return miningId === AUTH.miningId ? AUTH : null;
	}
}

function baseConfig(overrides: Partial<MiningEngineConfig> = {}): MiningEngineConfig {
	return {
		bindHost: '127.0.0.1',
		port: 0,
		network: net,
		poolTag: 'hearth-test',
		shareDifficulty: 5e-7,
		vardiffEnabled: false,
		vardiffTargetPerMin: 6,
		maxDifficulty: 2 ** 40,
		maxConnections: 128,
		blockPolicyShift: 0,
		asicPortEnabled: false,
		asicPort: 0,
		asicShareDifficulty: 65536,
		sv2Enabled: false,
		sv2Port: 3335,
		sv2ShareDifficulty: 65536,
		sv2VersionRolling: false,
		...overrides
	};
}

/** A fake Bitcoin Core RPC: getbestblockhash/getblock/getblocktemplate/submitblock. */
function fakeCoreRpc(template: GbtTemplate, onSubmit: (blockHex: string) => string | null) {
	const tipHash = template.previousblockhash; // the CURRENT tip is the template's prev
	return {
		call: async <T>(method: string, params?: unknown[]): Promise<T> => {
			switch (method) {
				case 'getbestblockhash':
					return tipHash as unknown as T;
				case 'getblock':
					return { height: template.height - 1 } as unknown as T;
				case 'getblocktemplate':
					return template as unknown as T;
				case 'submitblock':
					return onSubmit(params![0] as string) as unknown as T;
				default:
					throw new Error(`unexpected method ${method}`);
			}
		}
	};
}

function regtestTemplate(height: number, prevHash: string): GbtTemplate {
	return {
		version: 0x20000000,
		previousblockhash: prevHash,
		height,
		curtime: Math.floor(Date.now() / 1000),
		bits: '207fffff', // regtest powLimit — trivially easy, any nonce ~50% likely solves
		coinbasevalue: 5_000_000_000,
		transactions: []
	};
}

/** Minimal newline-JSON test client (mirrors stratum.spec.ts's TestClient). */
class TestClient {
	private buf = '';
	private readonly messages: Record<string, unknown>[] = [];
	private waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] =
		[];
	readonly socket: Socket;

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

	waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
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

	close(): void {
		this.socket.destroy();
	}
}

let pool: MiningPool | null = null;
let blocker: ReturnType<typeof createServer> | null = null;
afterEach(async () => {
	if (pool) await pool.stop();
	pool = null;
	if (blocker) await new Promise<void>((r) => blocker!.close(() => r()));
	blocker = null;
});

describe('miningPool: port-in-use', () => {
	it('when the ASIC port fails to bind, start() rejects and the standard listener is closed (no half-open engine)', async () => {
		// Pre-bind a fixed port so the ASIC listener collides.
		const fixedPort = 32101;
		blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker!.once('error', reject);
			blocker!.listen(fixedPort, '127.0.0.1', () => resolve());
		});

		const template = regtestTemplate(101, 'aa'.repeat(32));
		const rpc = fakeCoreRpc(template, () => null);
		pool = new MiningPool({
			rpc,
			authProvider: new OneMinerAuth(),
			config: baseConfig({ port: 0, asicPortEnabled: true, asicPort: fixedPort }),
			tipPollIntervalMs: 50
		});

		await expect(pool.start()).rejects.toThrow();
		expect(pool.status().listening).toBe(false);
	});
});

describe('miningPool: end-to-end solve', () => {
	it('a real StratumServer + job.ts solve assembles, verifies, and calls submitblock -> onBlockAccepted', async () => {
		const template = regtestTemplate(500, 'bb'.repeat(32));
		let submittedHex: string | null = null;
		const rpc = fakeCoreRpc(template, (hex) => {
			submittedHex = hex;
			return null; // accepted
		});

		let accepted: { solve: SolveEvent; blockHash: string; coinbaseTxid: string } | null = null;
		pool = new MiningPool({
			rpc,
			authProvider: new OneMinerAuth(),
			config: baseConfig(),
			tipPollIntervalMs: 20,
			onBlockAccepted: (solve, blockHash, coinbaseTxid) => {
				accepted = { solve, blockHash, coinbaseTxid };
			}
		});
		await pool.start();

		// Wait for the pool's tip poll to install the first job.
		await vitestWaitFor(() => pool!.status().lastJobAt !== null);

		const port = pool.status().port;
		const client = new TestClient(port);
		await client.waitForOpen();
		client.send({ id: 1, method: 'mining.subscribe', params: [] });
		const subResp = await client.waitFor((m) => m.id === 1);
		const en1 = (subResp.result as unknown[])[1] as string;
		client.send({ id: 2, method: 'mining.authorize', params: [AUTH.miningId, 'x'] });
		const authResp = await client.waitFor((m) => m.id === 2);
		expect(authResp.result).toBe(true);

		const notify = await client.waitFor((m) => m.method === 'mining.notify');
		const [jobId, , coinb1Hex, coinb2Hex, , , , ntimeHex] = notify.params as string[];
		void coinb1Hex;
		void coinb2Hex;

		// The ACCEPT gate is the (fixed, vardiff-disabled) share target at
		// shareDifficulty=5e-7 -- much HARDER than regtest's powLimit network
		// target here, so it's the binding constraint: any accepted share (hash
		// <= shareTarget) is automatically <= the (much easier) network target
		// too, i.e. also a solve. Brute-force against shareTarget, not the
		// network target, with a generous cap (expected ~1/2.3e-4 ≈ 4300 tries).
		const shareTarget = difficultyToTarget(5e-7);
		const en2 = '00000000';
		let nonceHex = '';
		// Rebuild locally with the SAME job/network/poolTag/cleanJobs to search
		// offline (buildJob is a pure function — identical to what the server holds).
		const { buildJob } = await import('./job.js');
		const built = buildJob(template, { network: net, poolTag: 'hearth-test', jobId, cleanJobs: true });
		const variant = built.personalize({ payoutScript: AUTH.payoutScript });
		for (let n = 0; n < 200_000; n++) {
			const candidate = n.toString(16).padStart(8, '0');
			const header = variant.headerFor(en1, en2, ntimeHex, candidate);
			if (hashValueFromDisplay(headerHashDisplay(header)) <= shareTarget) {
				nonceHex = candidate;
				break;
			}
		}
		expect(nonceHex).not.toBe('');

		client.send({ id: 10, method: 'mining.submit', params: ['default', jobId, en2, ntimeHex, nonceHex] });
		const submitResp = await client.waitFor((m) => m.id === 10);
		expect(submitResp.result).toBe(true);

		await vitestWaitFor(() => accepted !== null);
		expect(accepted!.solve.userId).toBe(AUTH.userId);
		expect(accepted!.blockHash).toBe(headerHashDisplay(variant.headerFor(en1, en2, ntimeHex, nonceHex)));
		expect(submittedHex).not.toBeNull();
		expect(pool.fatalErrors).toEqual([]);

		client.close();
	});
});

/** Small poll-until helper (avoids pulling in vi.waitFor's fake-timer coupling
 *  for a real-socket/real-timer integration test). */
async function vitestWaitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
		await new Promise((r) => setTimeout(r, 10));
	}
}
