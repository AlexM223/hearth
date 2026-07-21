/**
 * Mempool ticker tests (EXPLORER.md §5, §7 T8): idle-cost-zero (no publish,
 * no rail calls, when zero connections), publishes the lightweight payload
 * when connected, and never calls publish() with I/O still pending (the
 * hard invariant -- publish() itself never reads a rail, only pre-computed
 * data is handed to it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMempoolTicker, type MempoolTickerNode } from './mempoolTicker.js';
import { clearAllCaches } from './cache.js';
import * as events from '../events/index.js';
import type { RpcCaller } from '../node/core/rpc.js';

function mockNode(): MempoolTickerNode {
	const call = vi.fn(async (method: string) => {
		if (method === 'getmempoolinfo') return { size: 42, bytes: 1000, total_fee: 0.0001 };
		if (method === 'estimatesmartfee') return { feerate: 0.00002, blocks: 6 };
		throw new Error(`no handler for ${method}`);
	});
	return {
		coreRpc: { call: call as RpcCaller['call'] },
		electrum: {
			getFeeHistogram: vi.fn(async () => [[10, 1000]] as [number, number][]),
			estimateFee: vi.fn(async () => -1)
		}
	};
}

beforeEach(() => {
	clearAllCaches();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('chain/mempoolTicker: startMempoolTicker', () => {
	it('idle-cost-zero: no publish and no rail call when zero connections', async () => {
		vi.spyOn(events, 'connectionCount').mockReturnValue(0);
		const publishSpy = vi.spyOn(events, 'publish');
		const node = mockNode();

		const ticker = startMempoolTicker(node, 1000);
		await vi.advanceTimersByTimeAsync(0);

		expect(publishSpy).not.toHaveBeenCalled();
		expect(node.coreRpc.call).not.toHaveBeenCalled();
		ticker.stop();
	});

	it('publishes {satPerVb, txCount} on the mempool topic when connected', async () => {
		vi.spyOn(events, 'connectionCount').mockReturnValue(1);
		const publishSpy = vi.spyOn(events, 'publish');
		const node = mockNode();

		const ticker = startMempoolTicker(node, 1000);
		await vi.advanceTimersByTimeAsync(0);

		expect(publishSpy).toHaveBeenCalledWith(
			'mempool',
			{ kind: 'broadcast' },
			expect.objectContaining({ txCount: 42 })
		);
		ticker.stop();
	});

	it('ticks again after intervalMs while connected', async () => {
		vi.spyOn(events, 'connectionCount').mockReturnValue(1);
		const publishSpy = vi.spyOn(events, 'publish');
		const node = mockNode();

		const ticker = startMempoolTicker(node, 1000);
		await vi.advanceTimersByTimeAsync(0);
		expect(publishSpy).toHaveBeenCalledTimes(1);

		clearAllCaches(); // otherwise the TTL cache would short-circuit the next tick's rail calls
		await vi.advanceTimersByTimeAsync(1000);
		expect(publishSpy).toHaveBeenCalledTimes(2);

		ticker.stop();
	});

	it('stop() halts further ticks', async () => {
		vi.spyOn(events, 'connectionCount').mockReturnValue(1);
		const publishSpy = vi.spyOn(events, 'publish');
		const node = mockNode();

		const ticker = startMempoolTicker(node, 1000);
		await vi.advanceTimersByTimeAsync(0);
		ticker.stop();
		publishSpy.mockClear();

		await vi.advanceTimersByTimeAsync(5000);
		expect(publishSpy).not.toHaveBeenCalled();
	});

	it('a rail failure never crashes the ticker (logs and moves on)', async () => {
		vi.spyOn(events, 'connectionCount').mockReturnValue(1);
		const publishSpy = vi.spyOn(events, 'publish');
		const call = vi.fn(async () => {
			throw new Error('rail down');
		});
		const node: MempoolTickerNode = {
			coreRpc: { call: call as RpcCaller['call'] },
			electrum: {
				getFeeHistogram: vi.fn(async () => {
					throw new Error('rail down');
				}),
				estimateFee: vi.fn(async () => -1)
			}
		};

		const ticker = startMempoolTicker(node, 1000);
		await vi.advanceTimersByTimeAsync(0);
		expect(publishSpy).not.toHaveBeenCalled(); // nothing priced -- no fabricated payload
		ticker.stop();
	});
});
