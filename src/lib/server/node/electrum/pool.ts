/**
 * A small pool of ElectrumClient connections behind one ElectrumClient-shaped
 * facade (DECISIONS.md §4.4). Fans stateless requests across a few sockets
 * while keeping ALL subscriptions (and their notifications) on one
 * designated "primary" connection -- subscriptions are inherently per-socket,
 * and the block watcher / SSE bridge attach header/scripthash listeners to a
 * single EventEmitter. Ported pattern from cairn's electrum/pool.ts.
 *
 * Lane-aware picking (interactive vs background) exists so a bulk scan can't
 * starve an interactive page load: the background lane never sees the last
 * (reserved) socket in a multi-connection pool.
 */
import { EventEmitter } from 'node:events';
import { ElectrumClient } from './client.js';
import type {
	ElectrumClientOptions,
	ElectrumBalance,
	ElectrumFeeHistogram,
	ElectrumHistoryItem,
	ElectrumUnspent
} from './client.js';

const FORWARDED_EVENTS = ['connect', 'disconnect', 'header', 'scripthash'] as const;

export const DEFAULT_POOL_SIZE = 3;
export const MAX_POOL_SIZE = 4;

export type ElectrumLane = 'interactive' | 'background';

export function backgroundLaneWidth(poolSize: number): number {
	return Math.max(1, poolSize - 1);
}

export class ElectrumPool extends EventEmitter {
	private readonly clients: ElectrumClient[];
	private readonly primary: ElectrumClient;
	private rr = 0;

	constructor(opts: ElectrumClientOptions, size: number = DEFAULT_POOL_SIZE) {
		super();
		const n = Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(size) || DEFAULT_POOL_SIZE));
		this.clients = Array.from({ length: n }, () => new ElectrumClient(opts));
		this.primary = this.clients[0];

		this.setMaxListeners(64);
		this.on('error', () => {});

		for (const ev of FORWARDED_EVENTS) {
			this.primary.on(ev, (...args: unknown[]) => this.emit(ev, ...args));
		}
	}

	get server(): string {
		return this.primary.server;
	}

	get isConnected(): boolean {
		return this.primary.isConnected;
	}

	private eligibleClients(lane: ElectrumLane): ElectrumClient[] {
		if (lane === 'background' && this.clients.length > 1) {
			return this.clients.slice(0, this.clients.length - 1);
		}
		return this.clients;
	}

	/**
	 * Pick a connection for a stateless request: the least-loaded socket in
	 * the lane's eligible set, round-robin among ties (notably a cold pool
	 * where every count is 0).
	 */
	private pick(lane: ElectrumLane = 'interactive'): ElectrumClient {
		const eligible = this.eligibleClients(lane);
		let min = Infinity;
		for (const c of eligible) if (c.pendingCount < min) min = c.pendingCount;
		const tied = eligible.filter((c) => c.pendingCount === min);
		const chosen = tied[this.rr % tied.length];
		this.rr++;
		return chosen;
	}

	request(
		method: string,
		params: unknown[] = [],
		lane: ElectrumLane = 'interactive'
	): Promise<unknown> {
		return this.pick(lane).request(method, params);
	}

	batchRequest(
		items: { method: string; params: unknown[] }[],
		lane: ElectrumLane = 'interactive'
	): Promise<unknown[]> {
		return this.pick(lane).batchRequest(items);
	}

	getBalance(scripthash: string, lane: ElectrumLane = 'interactive'): Promise<ElectrumBalance> {
		return this.pick(lane).getBalance(scripthash);
	}

	getHistory(
		scripthash: string,
		lane: ElectrumLane = 'interactive'
	): Promise<ElectrumHistoryItem[]> {
		return this.pick(lane).getHistory(scripthash);
	}

	listUnspent(scripthash: string, lane: ElectrumLane = 'interactive'): Promise<ElectrumUnspent[]> {
		return this.pick(lane).listUnspent(scripthash);
	}

	broadcast(rawTxHex: string): Promise<string> {
		return this.pick().broadcast(rawTxHex);
	}

	getTransaction(txid: string, verbose = false, lane: ElectrumLane = 'interactive'): Promise<unknown> {
		return this.pick(lane).getTransaction(txid, verbose);
	}

	getMerkleProof(
		txid: string,
		height: number,
		lane: ElectrumLane = 'interactive'
	): Promise<{ block_height: number; merkle: string[]; pos: number }> {
		return this.pick(lane).getMerkleProof(txid, height);
	}

	getBlockHeader(height: number, lane: ElectrumLane = 'interactive'): Promise<string> {
		return this.pick(lane).getBlockHeader(height);
	}

	estimateFee(targetBlocks: number): Promise<number> {
		return this.pick().estimateFee(targetBlocks);
	}

	getFeeHistogram(): Promise<ElectrumFeeHistogram> {
		return this.pick().getFeeHistogram();
	}

	serverFeatures(): Promise<Record<string, unknown>> {
		return this.pick().serverFeatures();
	}

	ping(): Promise<void> {
		return this.pick().ping();
	}

	// ------------------------------------------------------- primary-only traffic

	headersSubscribe(): ReturnType<ElectrumClient['headersSubscribe']> {
		return this.primary.headersSubscribe();
	}

	subscribeScripthash(scripthash: string): Promise<string | null> {
		return this.primary.subscribeScripthash(scripthash);
	}

	unsubscribeScripthash(scripthash: string): Promise<boolean> {
		return this.primary.unsubscribeScripthash(scripthash);
	}

	banner(): Promise<string> {
		return this.primary.banner();
	}

	/** Tear down every pooled connection and stop all reconnect attempts. */
	close(): void {
		for (const client of this.clients) client.close();
	}
}
