import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from './rpc.js';
import type { CoreRpcConfig } from '../../config/index.js';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** Core's real work-queue 503 is plain text, not a JSON-RPC body -- see rpc.ts's
 *  JSON.parse-failure branch, the one that actually sets `httpStatus`. */
function workQueueOverflow(): Response {
	return new Response('Work queue depth exceeded', { status: 503 });
}

const config: CoreRpcConfig = {
	host: '127.0.0.1',
	port: 8332,
	user: 'alex',
	passEnvVar: 'HEARTH_TEST_CORE_RPC_PASS'
};

describe('node/core: RPC client', () => {
	beforeEach(() => {
		process.env.HEARTH_TEST_CORE_RPC_PASS = 'test-pass';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.HEARTH_TEST_CORE_RPC_PASS;
	});

	it('resolves the RPC result on a clean 200', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { result: 42, error: null, id: 1 }));
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config);
		await expect(rpc.call<number>('getblockcount')).resolves.toBe(42);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('sends HTTP Basic auth built from user + the configured password env var', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { result: 1, error: null, id: 1 }));
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config);
		await rpc.call('getblockcount');

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		const expected = 'Basic ' + Buffer.from('alex:test-pass').toString('base64');
		expect(headers.authorization).toBe(expected);
	});

	it('retries a 503 (Core work-queue overflow) with backoff, then succeeds', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(workQueueOverflow())
			.mockResolvedValueOnce(workQueueOverflow())
			.mockResolvedValueOnce(jsonResponse(200, { result: 'ok', error: null, id: 1 }));
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config, { maxRetries: 4 });
		await expect(rpc.call<string>('getblockcount')).resolves.toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('throws once retries are exhausted on a persistent 503', async () => {
		// mockImplementation (not mockResolvedValue) so every call gets a FRESH
		// Response -- a Response body can only be read once, and rpc.ts's
		// retry loop calls res.text() on every attempt.
		const fetchMock = vi.fn().mockImplementation(async () => workQueueOverflow());
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config, { maxRetries: 2 });
		await expect(rpc.call('getblockcount')).rejects.toThrow();
		// initial attempt + 2 retries = 3 calls
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('never retries a non-503 RPC error (e.g. bad method)', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { result: null, error: { code: -32601, message: 'Method not found' }, id: 1 }));
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config, { maxRetries: 4 });
		await expect(rpc.call('bogusmethod')).rejects.toThrow(/Method not found/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('caps in-flight requests at maxInflight, queuing the rest', async () => {
		let inFlightNow = 0;
		let maxObservedInFlight = 0;
		const fetchMock = vi.fn().mockImplementation(async () => {
			inFlightNow++;
			maxObservedInFlight = Math.max(maxObservedInFlight, inFlightNow);
			await new Promise((r) => setTimeout(r, 20));
			inFlightNow--;
			return jsonResponse(200, { result: 1, error: null, id: 1 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config, { maxInflight: 2 });
		await Promise.all(Array.from({ length: 6 }, () => rpc.call('getblockcount')));

		expect(maxObservedInFlight).toBeLessThanOrEqual(2);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it('serializes scanTxOutSet calls -- Core allows only one at a time', async () => {
		const order: string[] = [];
		const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string) as { method: string; id: number };
			order.push(`start:${body.id}`);
			await new Promise((r) => setTimeout(r, 10));
			order.push(`end:${body.id}`);
			return jsonResponse(200, {
				result: { success: true, txouts: 0, height: 0, bestblock: '', unspents: [], total_amount: 0 },
				error: null,
				id: body.id
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config);
		const first = rpc.scanTxOutSet('start', ['addr(a)']);
		const second = rpc.scanTxOutSet('start', ['addr(b)']);
		await Promise.all([first, second]);

		// The second scan's fetch must not START until the first has ENDED.
		const firstEndIdx = order.indexOf('end:1');
		const secondStartIdx = order.indexOf('start:2');
		expect(firstEndIdx).toBeGreaterThanOrEqual(0);
		expect(secondStartIdx).toBeGreaterThan(firstEndIdx);
	});

	it('wraps a network failure with a descriptive error rather than throwing raw', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		vi.stubGlobal('fetch', fetchMock);

		const rpc = new CoreRpcClient(config, { maxRetries: 0 });
		await expect(rpc.call('getblockcount')).rejects.toThrow(/connection failed/);
	});
});
