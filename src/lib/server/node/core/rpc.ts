/**
 * Bitcoin Core JSON-RPC client -- the canonical/explorer + mining rail
 * (DECISIONS.md §4.4). Ported pattern from nodeview's src/server/rpc.ts:
 * process-wide in-flight concurrency cap + 503/work-queue retry with
 * backoff (Core's default `rpcworkqueue` 503s under fan-out), and a
 * serialized `scantxoutset` queue (Core allows only one at a time).
 *
 * Auth: user/pass (HEARTH_CORE_RPC_USER/PASS) or a Core cookie file
 * (HEARTH_CORE_RPC_COOKIE) -- see buildAuthHeader().
 */
import { readFileSync } from 'node:fs';
import type { CoreRpcConfig } from '../../config/index.js';
import { logWarn } from '../../log.js';

interface RpcResponse<T> {
	result: T;
	error: { code: number; message: string } | null;
	id: number | string;
}

export interface RpcError extends Error {
	httpStatus?: number;
	rpcCode?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds the HTTP Basic auth header from user/pass or a Core .cookie file. */
function buildAuthHeader(config: CoreRpcConfig): string {
	if (config.cookiePath) {
		try {
			const contents = readFileSync(config.cookiePath, 'utf8').trim();
			// Core's cookie file is a single line "user:password".
			return 'Basic ' + Buffer.from(contents).toString('base64');
		} catch (e) {
			throw new Error(`Bitcoin Core RPC cookie file unreadable (${config.cookiePath}): ${e}`);
		}
	}
	const user = config.user ?? '';
	const pass = config.passEnvVar ? (process.env[config.passEnvVar] ?? '') : '';
	return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export class CoreRpcClient {
	private readonly url: string;
	private readonly maxInflight: number;
	private readonly maxRetries: number;
	private readonly timeoutMs: number;
	private inflight = 0;
	private waiters: Array<() => void> = [];
	private idCounter = 0;
	private scanQueue: Promise<unknown> = Promise.resolve();
	private readonly config: CoreRpcConfig;

	constructor(
		config: CoreRpcConfig,
		opts: { maxInflight?: number; maxRetries?: number; timeoutMs?: number } = {}
	) {
		this.config = config;
		this.url = `http://${config.host}:${config.port}/`;
		this.maxInflight = opts.maxInflight ?? 6;
		this.maxRetries = opts.maxRetries ?? 4;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
	}

	private acquire(): Promise<void> {
		if (this.inflight < this.maxInflight) {
			this.inflight++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.inflight--;
	}

	private async rpcOnce<T>(method: string, params: unknown[]): Promise<T> {
		const id = ++this.idCounter;
		const auth = buildAuthHeader(this.config);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await fetch(this.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: auth },
				body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
				signal: controller.signal
			});
		} catch (err) {
			const e = err as Error;
			const wrapped: RpcError = new Error(
				`Bitcoin Core RPC connection failed for ${method}: ${e.message}`
			);
			throw wrapped;
		} finally {
			clearTimeout(timer);
		}

		const text = await res.text();
		let body: RpcResponse<T> | undefined;
		try {
			body = JSON.parse(text) as RpcResponse<T>;
		} catch {
			if (!res.ok) {
				const err: RpcError = new Error(
					`Bitcoin Core RPC HTTP ${res.status} for ${method}: ${text.slice(0, 200)}`
				);
				err.httpStatus = res.status;
				throw err;
			}
			throw new Error(`Bitcoin Core RPC returned non-JSON for ${method}`);
		}

		if (body.error) {
			const err: RpcError = new Error(
				`Bitcoin Core RPC error (${body.error.code}) for ${method}: ${body.error.message}`
			);
			err.rpcCode = body.error.code;
			err.httpStatus = res.status;
			throw err;
		}
		return body.result;
	}

	/**
	 * Concurrency-limited, 503/work-queue-retrying JSON-RPC call. Throws
	 * (RpcError) on transport, HTTP, or RPC error that survives every retry.
	 */
	async call<T>(method: string, params: unknown[] = []): Promise<T> {
		await this.acquire();
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					return await this.rpcOnce<T>(method, params);
				} catch (err) {
					const e = err as RpcError;
					const retriable =
						e.httpStatus === 503 || /work queue depth exceeded/i.test(String(e.message));
					if (!retriable || attempt >= this.maxRetries) {
						if (retriable) {
							logWarn('core-rpc', {
								event: 'retries_exhausted',
								method,
								retries: this.maxRetries,
								err: e.message
							});
						}
						throw e;
					}
					await sleep(100 * 2 ** attempt); // 100, 200, 400, 800ms
				}
			}
		} finally {
			this.release();
		}
	}

	/** Core permits only ONE scantxoutset at a time; serialize callers through this queue. */
	scanTxOutSet(
		action: string,
		descriptors: Array<string | { desc: string }>
	): Promise<ScanTxOutResult> {
		const run = () => this.call<ScanTxOutResult>('scantxoutset', [action, descriptors]);
		const result = this.scanQueue.then(run, run);
		this.scanQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}
}

// ── Typed thin wrappers (trimmed to what M1's health snapshot + explorer need) ──

export interface BlockchainInfo {
	chain: string;
	blocks: number;
	headers: number;
	bestblockhash: string;
	difficulty: number;
	mediantime: number;
	verificationprogress: number;
	initialblockdownload: boolean;
	chainwork: string;
	size_on_disk: number;
	pruned: boolean;
}

export interface NetworkInfo {
	version: number;
	subversion: string;
	protocolversion: number;
	connections: number;
	connections_in: number;
	connections_out: number;
	networkactive: boolean;
}

export interface MempoolInfo {
	loaded: boolean;
	size: number;
	bytes: number;
	usage: number;
	total_fee: number;
	maxmempool: number;
	mempoolminfee: number;
}

export interface BlockHeader {
	hash: string;
	confirmations: number;
	height: number;
	version: number;
	versionHex: string;
	merkleroot: string;
	time: number;
	mediantime: number;
	nonce: number;
	bits: string;
	difficulty: number;
	chainwork: string;
	nTx: number;
	previousblockhash?: string;
	nextblockhash?: string;
}

export interface ScanTxOutResult {
	success: boolean;
	txouts: number;
	height: number;
	bestblock: string;
	unspents: Array<{
		txid: string;
		vout: number;
		scriptPubKey: string;
		desc: string;
		amount: number;
		height: number;
	}>;
	total_amount: number;
}

export const getBlockchainInfo = (rpc: CoreRpcClient) => rpc.call<BlockchainInfo>('getblockchaininfo');
export const getNetworkInfo = (rpc: CoreRpcClient) => rpc.call<NetworkInfo>('getnetworkinfo');
export const getMempoolInfo = (rpc: CoreRpcClient) => rpc.call<MempoolInfo>('getmempoolinfo');
export const getBlockCount = (rpc: CoreRpcClient) => rpc.call<number>('getblockcount');
export const getBestBlockHash = (rpc: CoreRpcClient) => rpc.call<string>('getbestblockhash');
export const getBlockHash = (rpc: CoreRpcClient, height: number) =>
	rpc.call<string>('getblockhash', [height]);
export const getBlockHeader = (rpc: CoreRpcClient, hash: string, verbose = true) =>
	rpc.call<BlockHeader>('getblockheader', [hash, verbose]);
