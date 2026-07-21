/**
 * Electrum protocol (JSON-RPC 2.0, newline-delimited) client over node:net
 * (plaintext) or node:tls. Ported pattern from cairn's
 * src/lib/server/electrum/client.ts (DECISIONS.md §4.4) -- pipelined
 * concurrent requests, subscriptions, reconnect-with-backoff, keepalive,
 * receive-buffer cap. Trimmed for Hearth: no SOCKS5/Tor (federation is
 * parked, §4.7), no chain-health side-channel (NodeClient owns health here).
 */
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { logWarn } from '../../log.js';

const CLIENT_NAME = 'Hearth 0.1';
const PROTOCOL_VERSION = '1.4';
const DEFAULT_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Public/self-hosted Electrum servers commonly enforce ~100s idle-socket
// timeouts; without a periodic keepalive a healthy connection gets dropped
// every ~90-120s, causing reconnect churn. 45s stays comfortably under that.
const KEEPALIVE_INTERVAL_MS = 45_000;
// Hard cap on the unparsed receive buffer (DoS guard). The wire protocol is
// newline-delimited: onData() accumulates bytes and drains complete lines, so
// a server that streams a payload and never sends a newline would grow
// `this.buffer` without bound. 32 MiB is far above any legitimate single
// Electrum response.
const MAX_BUFFER_SIZE = 32 * 1024 * 1024;

export interface ElectrumClientOptions {
	host: string;
	port: number;
	tls: boolean;
	tlsInsecure?: boolean;
	timeoutMs?: number;
	keepaliveIntervalMs?: number;
	maxBufferBytes?: number;
}

export interface ElectrumBalance {
	confirmed: number;
	unconfirmed: number;
}

export interface ElectrumHistoryItem {
	tx_hash: string;
	height: number;
	fee?: number;
}

export interface ElectrumUnspent {
	tx_hash: string;
	tx_pos: number;
	value: number;
	height: number;
}

export interface ElectrumHeader {
	height: number;
	hex: string;
}

export type ElectrumFeeHistogram = [number, number][];

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
	id?: number;
	method?: string;
	params?: unknown[];
	result?: unknown;
	error?: { code?: number; message?: string } | null;
}

/**
 * Events: 'header' (ElectrumHeader), 'scripthash' (scripthash, status),
 * 'connect', 'disconnect'.
 */
export class ElectrumClient extends EventEmitter {
	private readonly host: string;
	private readonly port: number;
	private readonly useTls: boolean;
	private readonly tlsInsecure: boolean;
	private readonly timeoutMs: number;
	private readonly keepaliveIntervalMs: number;
	private readonly maxBufferBytes: number;

	private socket: net.Socket | null = null;
	private connectingSocket: net.Socket | null = null;
	private connecting: Promise<void> | null = null;
	private closed = false;
	private buffer = '';
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();

	private headersSubscribed = false;
	private scripthashSubs = new Set<string>();

	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;
	private keepaliveTimer: NodeJS.Timeout | null = null;

	constructor(opts: ElectrumClientOptions) {
		super();
		this.host = opts.host;
		this.port = opts.port;
		this.useTls = opts.tls;
		this.tlsInsecure = opts.tlsInsecure ?? false;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
		this.maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_SIZE;
		// Consumers may not attach an 'error' listener; never let EventEmitter throw.
		this.on('error', () => {});
	}

	get server(): string {
		return `${this.host}:${this.port}`;
	}

	/** In-flight request count -- the pool's lane picker reads this. */
	get pendingCount(): number {
		return this.pending.size;
	}

	get isConnected(): boolean {
		return !!this.socket && !this.socket.destroyed;
	}

	// ---------------------------------------------------------------- transport

	private ensureConnected(): Promise<void> {
		if (this.closed) return Promise.reject(new Error('Client is closed'));
		if (this.socket && !this.socket.destroyed && !this.connecting) return Promise.resolve();
		if (this.connecting) return this.connecting;
		// A backoff reconnect is already scheduled -- fail fast instead of
		// hammering the dead server on every ambient request.
		if (this.reconnectTimer) {
			return Promise.reject(
				new Error(`Electrum reconnect to ${this.server} is backing off; try again shortly`)
			);
		}

		this.connecting = new Promise<void>((resolve, reject) => {
			let settled = false;
			let connectTimer: NodeJS.Timeout | null = null;

			const armConnectTimeout = (): void => {
				connectTimer = setTimeout(() => {
					connectTimer = null;
					if (this.connectingSocket) {
						this.connectingSocket.destroy();
						this.connectingSocket = null;
					}
					fail(
						new Error(
							`Electrum connect to ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`
						)
					);
				}, this.timeoutMs);
				connectTimer.unref?.();
			};
			const disarmConnectTimeout = (): void => {
				if (connectTimer) {
					clearTimeout(connectTimer);
					connectTimer = null;
				}
			};

			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				this.connecting = null;
				disarmConnectTimeout();
				reject(err);
			};

			let socket: net.Socket;
			const onReady = () => {
				disarmConnectTimeout();
				if (this.closed) {
					socket.destroy();
					fail(new Error('Client is closed'));
					return;
				}
				this.connectingSocket = null;
				this.socket = socket;
				this.rawRequest('server.version', [CLIENT_NAME, PROTOCOL_VERSION])
					.then(async () => {
						this.reconnectDelay = RECONNECT_MIN_MS;
						await this.resubscribe();
						this.startKeepalive();
						if (settled) return;
						settled = true;
						this.connecting = null;
						this.emit('connect');
						resolve();
					})
					.catch((err: unknown) => {
						socket.destroy();
						fail(err instanceof Error ? err : new Error(String(err)));
					});
			};

			const wrapTls = (): net.Socket =>
				tls.connect(
					{
						host: this.host,
						port: this.port,
						servername: this.host,
						rejectUnauthorized: !this.tlsInsecure
					},
					onReady
				);

			const attach = (s: net.Socket) => {
				this.connectingSocket = s;
				s.setEncoding('utf8');
				s.setTimeout(0);
				s.on('data', (chunk: string) => this.onData(chunk));
				s.on('error', (err: Error) => {
					this.emit('error', err);
					fail(new Error(`Electrum connection error (${this.server}): ${err.message}`));
				});
				s.on('close', () => {
					fail(new Error(`Electrum connection closed (${this.server})`));
					this.onDisconnect();
				});
			};

			try {
				if (this.useTls) {
					armConnectTimeout();
					socket = wrapTls();
					attach(socket);
				} else {
					armConnectTimeout();
					socket = net.connect({ host: this.host, port: this.port }, onReady);
					attach(socket);
				}
			} catch (e) {
				fail(e instanceof Error ? e : new Error(String(e)));
			}
		});
		return this.connecting;
	}

	/** Keepalive against idle-socket timeouts: ping when connected and idle. */
	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = setInterval(() => {
			const socket = this.socket;
			if (!socket || socket.destroyed || this.pending.size > 0) return;
			this.rawRequest('server.ping', []).catch(() => {
				// A missed keepalive means the socket is a zombie -- destroy it and
				// let the normal close -> onDisconnect -> backoff-reconnect path run.
				if (this.socket === socket && !socket.destroyed) {
					logWarn('electrum', { event: 'keepalive_failed', server: this.server });
					socket.destroy();
				}
			});
		}, this.keepaliveIntervalMs);
		this.keepaliveTimer.unref?.();
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	private onDisconnect(): void {
		this.stopKeepalive();
		this.connectingSocket = null;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this.buffer = '';
		this.rejectAllPending(new Error(`Electrum connection lost (${this.server})`));
		if (this.closed) {
			this.emit('disconnect');
			return;
		}
		// Arm the backoff reconnect BEFORE notifying listeners, so a request
		// fired synchronously off 'disconnect' still sees ensureConnected()'s
		// fail-fast guard rather than redialing the dead server immediately.
		if ((this.headersSubscribed || this.scripthashSubs.size > 0) && !this.reconnectTimer) {
			const delay = this.reconnectDelay;
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				if (this.closed) return;
				this.ensureConnected().catch((e: unknown) => {
					logWarn('electrum', { event: 'reconnect_failed', server: this.server, err: String(e) });
				});
			}, delay);
			this.reconnectTimer.unref?.();
		}
		this.emit('disconnect');
	}

	private rejectAllPending(err: Error): void {
		for (const [, req] of this.pending) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		this.pending.clear();
	}

	private async resubscribe(): Promise<void> {
		if (this.headersSubscribed) {
			try {
				const header = (await this.rawRequest('blockchain.headers.subscribe', [])) as ElectrumHeader;
				this.emit('header', header);
			} catch (e) {
				logWarn('electrum', { event: 'resubscribe_headers_failed', server: this.server, err: String(e) });
			}
		}
		const subs = [...this.scripthashSubs];
		if (subs.length === 0) return;
		// Replay concurrently so reconnect latency doesn't scale with sub count.
		await Promise.allSettled(
			subs.map(async (sh) => {
				const status = await this.rawRequest('blockchain.scripthash.subscribe', [sh]);
				this.emit('scripthash', sh, status as string | null);
			})
		);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // ignore malformed lines
			}
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				logWarn('electrum', { event: 'non_object_message', server: this.server });
				continue;
			}
			try {
				this.dispatch(parsed as JsonRpcMessage);
			} catch (e) {
				logWarn('electrum', { event: 'dispatch_threw', server: this.server, err: String(e) });
			}
		}
		if (this.buffer.length > this.maxBufferBytes) {
			logWarn('electrum', {
				event: 'buffer_cap_exceeded',
				server: this.server,
				bufferBytes: this.buffer.length
			});
			this.buffer = '';
			const sock = this.socket ?? this.connectingSocket;
			sock?.destroy();
		}
	}

	private dispatch(msg: JsonRpcMessage): void {
		if (typeof msg.id === 'number') {
			const req = this.pending.get(msg.id);
			if (!req) return;
			this.pending.delete(msg.id);
			clearTimeout(req.timer);
			if (msg.error) {
				req.reject(new Error(`Electrum error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
			} else {
				req.resolve(msg.result);
			}
			return;
		}
		if (msg.method === 'blockchain.headers.subscribe' && Array.isArray(msg.params)) {
			this.emit('header', msg.params[0] as ElectrumHeader);
		} else if (msg.method === 'blockchain.scripthash.subscribe' && Array.isArray(msg.params)) {
			this.emit('scripthash', msg.params[0] as string, (msg.params[1] ?? null) as string | null);
		}
	}

	private rawRequest(method: string, params: unknown[]): Promise<unknown> {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return Promise.reject(new Error(`Not connected to ${this.server}`));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Electrum request timed out after ${this.timeoutMs}ms: ${method}`));
			}, this.timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
				if (err) {
					const req = this.pending.get(id);
					if (req) {
						this.pending.delete(id);
						clearTimeout(req.timer);
						req.reject(new Error(`Electrum write failed: ${err.message}`));
					}
				}
			});
		});
	}

	// ------------------------------------------------------------------- public

	async request(method: string, params: unknown[] = []): Promise<unknown> {
		await this.ensureConnected();
		return this.rawRequest(method, params);
	}

	async batchRequest(items: { method: string; params: unknown[] }[]): Promise<unknown[]> {
		await this.ensureConnected();
		return Promise.all(items.map((it) => this.rawRequest(it.method, it.params)));
	}

	async getBalance(scripthash: string): Promise<ElectrumBalance> {
		return (await this.request('blockchain.scripthash.get_balance', [scripthash])) as ElectrumBalance;
	}

	async getHistory(scripthash: string): Promise<ElectrumHistoryItem[]> {
		return (await this.request('blockchain.scripthash.get_history', [
			scripthash
		])) as ElectrumHistoryItem[];
	}

	async listUnspent(scripthash: string): Promise<ElectrumUnspent[]> {
		return (await this.request('blockchain.scripthash.listunspent', [
			scripthash
		])) as ElectrumUnspent[];
	}

	async broadcast(rawTxHex: string): Promise<string> {
		return (await this.request('blockchain.transaction.broadcast', [rawTxHex])) as string;
	}

	async getTransaction(txid: string, verbose = false): Promise<unknown> {
		return this.request('blockchain.transaction.get', [txid, verbose]);
	}

	async getMerkleProof(
		txid: string,
		height: number
	): Promise<{ block_height: number; merkle: string[]; pos: number }> {
		return (await this.request('blockchain.transaction.get_merkle', [txid, height])) as {
			block_height: number;
			merkle: string[];
			pos: number;
		};
	}

	async getBlockHeader(height: number): Promise<string> {
		return (await this.request('blockchain.block.header', [height])) as string;
	}

	/** BTC/kvB (Electrum convention), or -1 when the server has no estimate. */
	async estimateFee(targetBlocks: number): Promise<number> {
		return (await this.request('blockchain.estimatefee', [targetBlocks])) as number;
	}

	async getFeeHistogram(): Promise<ElectrumFeeHistogram> {
		return (await this.request('mempool.get_fee_histogram', [])) as ElectrumFeeHistogram;
	}

	/** Subscribe to new headers; resolves with the current tip. */
	async headersSubscribe(): Promise<ElectrumHeader> {
		const header = (await this.request('blockchain.headers.subscribe', [])) as ElectrumHeader;
		this.headersSubscribed = true;
		return header;
	}

	async subscribeScripthash(scripthash: string): Promise<string | null> {
		const status = (await this.request('blockchain.scripthash.subscribe', [scripthash])) as
			| string
			| null;
		this.scripthashSubs.add(scripthash);
		return status;
	}

	async unsubscribeScripthash(scripthash: string): Promise<boolean> {
		const wasWatched = this.scripthashSubs.delete(scripthash);
		if (!wasWatched) return false;
		const socket = this.socket;
		if (!socket || socket.destroyed) return false;
		try {
			await this.rawRequest('blockchain.scripthash.unsubscribe', [scripthash]);
			return true;
		} catch {
			return false;
		}
	}

	async banner(): Promise<string> {
		return (await this.request('server.banner', [])) as string;
	}

	async serverFeatures(): Promise<Record<string, unknown>> {
		return (await this.request('server.features', [])) as Record<string, unknown>;
	}

	async ping(): Promise<void> {
		await this.request('server.ping', []);
	}

	/** Tear down the connection and stop all reconnect attempts. */
	close(): void {
		this.closed = true;
		this.stopKeepalive();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.headersSubscribed = false;
		this.scripthashSubs.clear();
		this.rejectAllPending(new Error('Client closed'));
		if (this.connectingSocket) {
			this.connectingSocket.destroy();
			this.connectingSocket = null;
		}
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
	}
}
