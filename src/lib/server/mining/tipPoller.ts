/**
 * Chain-tip poller for the solo mining engine (MINING-ENGINE.md §1.3;
 * adapted from the Tessera pool TipPoller, C:\dev\raffle\pool\src\rpc.ts, via
 * cairn's mining/tipPoller.ts).
 *
 * Polls getbestblockhash on an interval and emits `tip` with `{height, hash}`
 * once per NEW best hash -- including the first tip observed after start().
 * Transient RPC failures are swallowed and retried on the next tick.
 *
 * Decoupled from any concrete client: it accepts a generic `{ call(method,
 * params) }` RPC interface, which hearth's CoreRpcClient satisfies directly
 * (node/core/rpc.ts's RpcCaller). No ZMQ dependency (DECISIONS.md's ZMQ note
 * is hashblock-only for the block watcher; mining polls independently).
 */
import { EventEmitter } from 'node:events';

/** Minimal RPC surface the poller needs -- CoreRpcClient.call<T> matches this. */
export interface RpcLike {
	call<T>(method: string, params?: unknown[]): Promise<T>;
}

export interface ChainTip {
	readonly height: number;
	readonly hash: string;
}

const DEFAULT_INTERVAL_MS = 1000;

export class TipPoller extends EventEmitter {
	private timer: NodeJS.Timeout | null = null;
	private inFlight = false;
	private running = false;
	private lastHash: string | null = null;

	constructor(
		private readonly rpc: RpcLike,
		private readonly intervalMs = DEFAULT_INTERVAL_MS
	) {
		super();
	}

	override on(event: 'tip', listener: (tip: ChainTip) => void): this {
		return super.on(event, listener);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		const tick = async (): Promise<void> => {
			if (this.inFlight || !this.running) return;
			this.inFlight = true;
			try {
				const hash = await this.rpc.call<string>('getbestblockhash');
				if (hash !== this.lastHash) {
					// Fetch the height OF THIS HASH (not getblockcount, which could
					// already point at a newer tip and mismatch the hash).
					const block = await this.rpc.call<{ height: number }>('getblock', [hash, 1]);
					this.lastHash = hash;
					if (this.running) {
						this.emit('tip', { height: block.height, hash } satisfies ChainTip);
					}
				}
			} catch {
				// Node briefly unavailable (startup/shutdown) -- retry next tick.
			} finally {
				this.inFlight = false;
			}
		};
		this.timer = setInterval(() => void tick(), this.intervalMs);
		this.timer.unref?.();
		void tick(); // immediate first poll, no interval-lag on start
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
