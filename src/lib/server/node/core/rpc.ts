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

// ── Explorer rail wrappers (EXPLORER.md §1.3/§7 T0) ──────────────────────

export interface RawTxScriptSig {
	asm: string;
	hex: string;
}
export interface RawTxVin {
	txid?: string;
	vout?: number;
	coinbase?: string;
	scriptSig?: RawTxScriptSig;
	txinwitness?: string[];
	sequence: number;
}
export interface RawTxScriptPubKey {
	asm: string;
	hex: string;
	address?: string;
	type: string;
}
export interface RawTxVout {
	value: number; // BTC, not sats -- caller converts
	n: number;
	scriptPubKey: RawTxScriptPubKey;
}
/** `getrawtransaction(txid, true)` shape -- decoded vin/vout, NOT prevout
 *  values/addresses (Core leaves prevout resolution to the caller, §1.5). */
export interface RawTransaction {
	txid: string;
	hash: string;
	version: number;
	size: number;
	vsize: number;
	weight: number;
	locktime: number;
	vin: RawTxVin[];
	vout: RawTxVout[];
	hex: string;
	blockhash?: string;
	confirmations?: number;
	blocktime?: number;
	time?: number;
}

/** `getblock(hash, 1)` -- header fields + the ordered txid list only (cheap). */
export interface BlockVerbose1 extends BlockHeader {
	strippedsize: number;
	size: number;
	weight: number;
	tx: string[];
}
/** `getblock(hash, 2)` -- header fields + every tx fully decoded (expensive;
 *  `chain/blocks.ts` never requests this for a whole block, only verbosity 1
 *  + a bounded per-tx `getrawtransaction` pass, §1.4). */
export interface BlockVerbose2 extends BlockHeader {
	strippedsize: number;
	size: number;
	weight: number;
	tx: RawTransaction[];
}

export function getRawTransaction(rpc: CoreRpcClient, txid: string, verbose: false): Promise<string>;
export function getRawTransaction(
	rpc: CoreRpcClient,
	txid: string,
	verbose?: true
): Promise<RawTransaction>;
export function getRawTransaction(
	rpc: CoreRpcClient,
	txid: string,
	verbose: boolean = true
): Promise<string | RawTransaction> {
	return rpc.call('getrawtransaction', [txid, verbose]);
}

export function getBlock(rpc: CoreRpcClient, hash: string, verbosity: 0): Promise<string>;
export function getBlock(rpc: CoreRpcClient, hash: string, verbosity?: 1): Promise<BlockVerbose1>;
export function getBlock(rpc: CoreRpcClient, hash: string, verbosity: 2): Promise<BlockVerbose2>;
export function getBlock(
	rpc: CoreRpcClient,
	hash: string,
	verbosity: 0 | 1 | 2 = 1
): Promise<string | BlockVerbose1 | BlockVerbose2> {
	return rpc.call('getblock', [hash, verbosity]);
}

export interface TxOutScriptPubKey {
	asm: string;
	hex: string;
	address?: string;
	type: string;
}
/** `gettxout` -- ONLY sees unspent outputs; null on a spent or unknown output.
 *  Not used for prevout resolution (§1.3 -- would fail on the common already-
 *  spent case), only for the tx-detail "spent/unspent" dot on OWN outputs
 *  where the app doesn't already know the spend from its own wallet data. */
export interface TxOutResult {
	bestblock: string;
	confirmations: number;
	value: number;
	scriptPubKey: TxOutScriptPubKey;
	coinbase: boolean;
}
export function getTxOut(
	rpc: CoreRpcClient,
	txid: string,
	n: number,
	includeMempool = true
): Promise<TxOutResult | null> {
	return rpc.call('gettxout', [txid, n, includeMempool]);
}

export interface MempoolEntryFees {
	base: number;
	modified: number;
	ancestor: number;
	descendant: number;
}
export interface MempoolEntry {
	vsize: number;
	weight: number;
	time: number;
	height: number;
	descendantcount: number;
	descendantsize: number;
	ancestorcount: number;
	ancestorsize: number;
	wtxid: string;
	fees: MempoolEntryFees;
	depends: string[];
	spentby: string[];
	'bip125-replaceable': boolean;
}
/** Fails fast (rejects) when `txid` isn't in the mempool -- CPFP (§1.5.1)
 *  relies on this to skip ancestor/descendant calls for a confirmed tx. */
export const getMempoolEntry = (rpc: CoreRpcClient, txid: string) =>
	rpc.call<MempoolEntry>('getmempoolentry', [txid]);

export function getRawMempool(rpc: CoreRpcClient, verbose: false): Promise<string[]>;
export function getRawMempool(rpc: CoreRpcClient, verbose: true): Promise<Record<string, MempoolEntry>>;
export function getRawMempool(
	rpc: CoreRpcClient,
	verbose: boolean = false
): Promise<string[] | Record<string, MempoolEntry>> {
	return rpc.call('getrawmempool', [verbose]);
}

export function getMempoolAncestors(rpc: CoreRpcClient, txid: string, verbose: false): Promise<string[]>;
export function getMempoolAncestors(
	rpc: CoreRpcClient,
	txid: string,
	verbose: true
): Promise<Record<string, MempoolEntry>>;
export function getMempoolAncestors(
	rpc: CoreRpcClient,
	txid: string,
	verbose: boolean = false
): Promise<string[] | Record<string, MempoolEntry>> {
	return rpc.call('getmempoolancestors', [txid, verbose]);
}

export function getMempoolDescendants(rpc: CoreRpcClient, txid: string, verbose: false): Promise<string[]>;
export function getMempoolDescendants(
	rpc: CoreRpcClient,
	txid: string,
	verbose: true
): Promise<Record<string, MempoolEntry>>;
export function getMempoolDescendants(
	rpc: CoreRpcClient,
	txid: string,
	verbose: boolean = false
): Promise<string[] | Record<string, MempoolEntry>> {
	return rpc.call('getmempooldescendants', [txid, verbose]);
}

export type EstimateMode = 'UNSET' | 'ECONOMICAL' | 'CONSERVATIVE';
export interface SmartFeeEstimate {
	feerate?: number; // BTC/kvB when an estimate exists
	errors?: string[];
	blocks: number;
}
/** Core's estimator -- the Electrum-down fallback per target in the fee
 *  ladder (§1.3's fee-recommendation row). */
export const estimateSmartFee = (
	rpc: CoreRpcClient,
	confTarget: number,
	estimateMode: EstimateMode = 'CONSERVATIVE'
) => rpc.call<SmartFeeEstimate>('estimatesmartfee', [confTarget, estimateMode]);
