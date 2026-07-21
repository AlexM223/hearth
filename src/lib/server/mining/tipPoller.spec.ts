/**
 * T4 acceptance (MINING-ENGINE.md §1.3): emits 'tip' once per NEW best hash
 * (including the first observed tip), swallows transient RPC failures and
 * retries, and stop() halts further polling.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { TipPoller, type RpcLike } from './tipPoller.js';

function fakeRpc(hashes: (string | Error)[]): RpcLike {
	let i = 0;
	return {
		call: async <T>(method: string, params?: unknown[]): Promise<T> => {
			if (method === 'getbestblockhash') {
				const next = hashes[Math.min(i, hashes.length - 1)]!;
				i++;
				if (next instanceof Error) throw next;
				return next as unknown as T;
			}
			if (method === 'getblock') {
				const hash = params![0] as string;
				return { height: hash.length, hash } as unknown as T;
			}
			throw new Error(`unexpected method ${method}`);
		}
	};
}

let poller: TipPoller | null = null;
afterEach(() => {
	poller?.stop();
	poller = null;
});

describe('mining/tipPoller', () => {
	it('emits the first observed tip immediately on start (no interval lag)', async () => {
		const rpc = fakeRpc(['aa'.repeat(32)]);
		poller = new TipPoller(rpc, 100_000); // long interval — relies on the immediate first poll
		const tips: { height: number; hash: string }[] = [];
		poller.on('tip', (t) => tips.push(t));
		poller.start();
		await vi.waitFor(() => expect(tips).toHaveLength(1));
		expect(tips[0]!.hash).toBe('aa'.repeat(32));
	});

	it('does not re-emit when the hash is unchanged across ticks', async () => {
		const rpc = fakeRpc(['aa'.repeat(32), 'aa'.repeat(32), 'aa'.repeat(32)]);
		poller = new TipPoller(rpc, 5);
		const tips: unknown[] = [];
		poller.on('tip', (t) => tips.push(t));
		poller.start();
		await new Promise((r) => setTimeout(r, 60));
		expect(tips).toHaveLength(1);
	});

	it('emits again when the hash changes', async () => {
		const rpc = fakeRpc(['aa'.repeat(32), 'bb'.repeat(32)]);
		poller = new TipPoller(rpc, 5);
		const tips: { hash: string }[] = [];
		poller.on('tip', (t) => tips.push(t));
		poller.start();
		await vi.waitFor(() => expect(tips.length).toBeGreaterThanOrEqual(2));
		expect(tips.map((t) => t.hash)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
	});

	it('swallows a transient RPC failure and keeps polling', async () => {
		const rpc = fakeRpc([new Error('connection refused'), 'cc'.repeat(32)]);
		poller = new TipPoller(rpc, 5);
		const tips: unknown[] = [];
		poller.on('tip', (t) => tips.push(t));
		expect(() => poller!.start()).not.toThrow();
		await vi.waitFor(() => expect(tips).toHaveLength(1));
	});

	it('stop() halts further emissions', async () => {
		const rpc = fakeRpc(['aa'.repeat(32)]);
		poller = new TipPoller(rpc, 5);
		let count = 0;
		poller.on('tip', () => count++);
		poller.start();
		await vi.waitFor(() => expect(count).toBe(1));
		poller.stop();
		await new Promise((r) => setTimeout(r, 30));
		expect(count).toBe(1);
	});

	it('start() is idempotent (calling twice does not double the timer)', () => {
		const rpc = fakeRpc(['aa'.repeat(32)]);
		poller = new TipPoller(rpc, 100_000);
		poller.start();
		expect(() => poller!.start()).not.toThrow();
	});
});
