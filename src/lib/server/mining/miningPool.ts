/**
 * MiningPool -- the solo mining engine coordinator (MINING-ENGINE.md §1, §2.6,
 * §2.7). Rewrite of the Tessera pool orchestrator
 * (C:\dev\raffle\pool\src\pool.ts) stripped to the solo core, via cairn's
 * miningPool.ts (SV2 listener entirely removed -- M8, not built here).
 *
 * Wires the modules together:
 *   TipPoller --tip--> getblocktemplate --> buildJob --> StratumServer.setJob
 *   StratumServer --solve--> re-personalize -> assemble -> submitblock -> callback
 *
 * Event ordering: tip and solve handlers (and the 30s fee-refresh rebuild) run
 * on ONE serialized promise queue -- getblocktemplate and submitblock must not
 * interleave. Invariant violations are recorded in `fatalErrors` (never thrown
 * mid-queue -- a throw would poison the queue and crash nothing else);
 * transient RPC errors are logged and retried by the next event.
 *
 * `wire.ts`/`coinbase.ts`/`job.ts`/this file stay DB/SvelteKit-free (MINING-
 * ENGINE.md §1.1) -- the forced-solve QA driver (T8) imports this module
 * through a raw Node loader with no SvelteKit runtime. The auth snapshot is
 * INJECTED (authProvider), never looked up here.
 */
import { randomBytes } from 'node:crypto';
import { buildJob } from './job.js';
import { StratumServer, type StratumServerOptions } from './stratum.js';
import { TipPoller, type ChainTip, type RpcLike } from './tipPoller.js';
import type {
	AuthProvider,
	BuiltJob,
	EngineStatus,
	GbtTemplate,
	MiningEngineConfig,
	RejectEvent,
	ShareEvent,
	SolveEvent
} from './types.js';

/** Keep more BuiltJobs than the Stratum window so any in-window solve assembles. */
const JOB_RETENTION = 8;
/** Rebuild the job (fresh fees, cleanJobs:false) on this cadence between tips. */
const DEFAULT_FEE_REFRESH_MS = 30_000;

export interface MiningPoolOptions {
	readonly rpc: RpcLike;
	readonly config: MiningEngineConfig;
	readonly authProvider: AuthProvider;
	/** Invoked after bitcoind ACCEPTS a submitted block (result === null). */
	readonly onBlockAccepted?: (solve: SolveEvent, blockHash: string, coinbaseTxid: string) => void;
	/** Invoked when bitcoind REJECTS a submitted block (loud, non-fatal). */
	readonly onBlockRejected?: (solve: SolveEvent, reason: string) => void;
	/** Optional passthrough of accepted-share events (stats bridge). */
	readonly onShare?: (e: ShareEvent) => void;
	/** Optional passthrough of rejected-submit events. */
	readonly onReject?: (e: RejectEvent) => void;
	readonly log?: (msg: string) => void;
	readonly tipPollIntervalMs?: number;
	readonly feeRefreshMs?: number;
}

export class MiningPool {
	private readonly opts: MiningPoolOptions;
	private readonly config: MiningEngineConfig;
	private readonly log: (msg: string) => void;

	/** The standard-floor listener (default port 3333, low share difficulty). */
	private readonly server: StratumServer;
	/**
	 * The optional high-floor ASIC listener (default port 3334). Runs the SAME
	 * engine as {@link server} -- same job pipeline, per-connection coinbase,
	 * auth provider, share/solve/reject handlers, and vardiff mechanism --
	 * differing only in bind port and difficulty floor. Null when
	 * `asicPortEnabled` is false.
	 */
	private readonly asicServer: StratumServer | null;
	private poller: TipPoller | null = null;
	private feeTimer: NodeJS.Timeout | null = null;

	/** Serialized event queue: tips, refreshes, and solves never interleave. */
	private queue: Promise<void> = Promise.resolve();

	private readonly jobPrefix = randomBytes(3).toString('hex');
	private jobCounter = 0;
	private readonly jobsById = new Map<string, BuiltJob>();

	private currentTip: ChainTip | null = null;
	private lastTipHeight: number | null = null;
	private lastJobAt: number | null = null;
	private lastTemplateOk = false;
	private readonly fatal: string[] = [];

	private started = false;
	private stopping = false;
	private stopPromise: Promise<void> | null = null;

	constructor(opts: MiningPoolOptions) {
		this.opts = opts;
		this.config = opts.config;
		this.log = opts.log ?? ((msg) => console.log(`[mining] ${msg}`));

		// Both listeners are wired IDENTICALLY -- same auth provider, same solve
		// queue, same share/reject sinks, same vardiff opts -- and differ ONLY in
		// bind port and difficulty floor (start difficulty + the vardiff floor
		// clamp StratumServer applies against its own opts.shareDifficulty). A
		// solve from either lands on the shared serialized queue and resolves
		// against the shared jobsById map (both are handed the same BuiltJob by
		// setJob), so which port found the block is irrelevant to assembly.
		const makeServerOpts = (port: number, shareDifficulty: number): StratumServerOptions => ({
			port,
			host: this.config.bindHost,
			shareDifficulty,
			network: this.config.network,
			authProvider: opts.authProvider,
			blockPolicyShift: this.config.blockPolicyShift,
			maxConnections: this.config.maxConnections,
			log: this.log,
			onShare: (e) => opts.onShare?.(e),
			onSolve: (e) => this.enqueue(() => this.handleSolve(e)),
			onReject: (e) => opts.onReject?.(e),
			...(this.config.vardiffEnabled
				? {
						vardiff: {
							targetSharesPerMin: this.config.vardiffTargetPerMin,
							maxDifficulty: this.config.maxDifficulty
						}
					}
				: {})
		});
		this.server = new StratumServer(makeServerOpts(this.config.port, this.config.shareDifficulty));
		this.asicServer = this.config.asicPortEnabled
			? new StratumServer(makeServerOpts(this.config.asicPort, this.config.asicShareDifficulty))
			: null;
	}

	/** Invariant violations observed at runtime (the forced-solve harness asserts empty). */
	get fatalErrors(): readonly string[] {
		return this.fatal;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error('MiningPool already started');
		this.started = true;
		await this.server.listen();
		this.log(
			`stratum listening on ${this.config.bindHost}:${this.server.port} ` +
				`(share difficulty ${this.config.shareDifficulty})`
		);
		if (this.asicServer) {
			try {
				await this.asicServer.listen();
			} catch (err) {
				// The ASIC port failed to bind (busy / same as the standard port). Close
				// the standard listener we already opened so start() fails cleanly with
				// no half-open engine, and re-throw for doStart() to record as fatal.
				this.started = false;
				try {
					await this.server.close();
				} catch {
					/* best-effort -- we are already failing the start */
				}
				throw err;
			}
			this.log(
				`asic stratum listening on ${this.config.bindHost}:${this.asicServer.port} ` +
					`(share difficulty ${this.config.asicShareDifficulty})`
			);
		}

		this.poller = new TipPoller(this.opts.rpc, this.opts.tipPollIntervalMs ?? 1000);
		this.poller.on('tip', (tip) => this.enqueue(() => this.handleTip(tip)));
		this.poller.start();

		const refreshMs = this.opts.feeRefreshMs ?? DEFAULT_FEE_REFRESH_MS;
		this.feeTimer = setInterval(() => this.enqueue(() => this.refreshJob()), refreshMs);
		this.feeTimer.unref?.();
	}

	/** Idempotent: stops polling + fee refresh, closes the server, drains events. */
	stop(): Promise<void> {
		this.stopPromise ??= this.doStop();
		return this.stopPromise;
	}

	private async doStop(): Promise<void> {
		this.stopping = true;
		this.poller?.stop();
		if (this.feeTimer) {
			clearInterval(this.feeTimer);
			this.feeTimer = null;
		}
		// Close every listener; nested try/finally guarantees the ASIC listener
		// is closed even if the standard one's close rejects (never leak a bound
		// port).
		try {
			await this.server.close();
		} finally {
			if (this.asicServer) await this.asicServer.close();
		}
		await this.queue; // drain in-flight tip/solve/refresh handlers
		this.log('stopped');
	}

	status(): EngineStatus {
		const stdConns = this.server.connections();
		const asicConns = this.asicServer ? this.asicServer.connections() : [];
		return {
			// Honest only when EVERY configured listener is up.
			listening: this.server.listening && (this.asicServer === null || this.asicServer.listening),
			bind: this.config.bindHost,
			port: this.server.port,
			lastTipHeight: this.lastTipHeight,
			lastJobAt: this.lastJobAt,
			lastTemplateOk: this.lastTemplateOk,
			minerCount: this.server.minerCount + (this.asicServer?.minerCount ?? 0),
			// COMBINED across every listener -- readModels counts distinct users from this.
			connections: [...stdConns, ...asicConns],
			listeners: [
				{ role: 'standard', port: this.server.port, connections: stdConns.length },
				...(this.asicServer
					? [{ role: 'asic' as const, port: this.asicServer.port, connections: asicConns.length }]
					: [])
			],
			fatalErrors: [...this.fatal]
		};
	}

	// ------------------------------------------------------------- event queue

	private enqueue(fn: () => Promise<void>): void {
		this.queue = this.queue.then(fn).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			this.fatal.push(msg);
			this.log(`FATAL: ${msg}`);
		});
	}

	/** Record an invariant violation: loud, fatal-listed, but non-crashing. */
	private invariant(msg: string): void {
		this.fatal.push(msg);
		this.log(`INVARIANT VIOLATION: ${msg}`);
	}

	private getBlockTemplate(): Promise<GbtTemplate> {
		return this.opts.rpc.call<GbtTemplate>('getblocktemplate', [{ rules: ['segwit'] }]);
	}

	// -------------------------------------------------------------------- tips

	private async handleTip(tip: ChainTip): Promise<void> {
		if (this.stopping) return;
		this.lastTipHeight = tip.height;
		let template: GbtTemplate;
		try {
			template = await this.getBlockTemplate();
			this.lastTemplateOk = true;
		} catch (err) {
			this.lastTemplateOk = false;
			this.log(`getblocktemplate failed (transient, will retry on next tip): ${String(err)}`);
			return;
		}
		if (template.previousblockhash !== tip.hash) {
			// The chain moved between the poll and the template: this tip is stale;
			// the poller has already (or will) emit the newer tip.
			this.log(`tip ${tip.height} ${tip.hash.slice(0, 12)}… stale vs template prev — skipped`);
			return;
		}
		if (template.height !== tip.height + 1) {
			this.invariant(`template height ${template.height} != tip height ${tip.height} + 1`);
			return;
		}
		this.currentTip = tip;
		this.installJob(template, true);
		this.log(`tip ${tip.height} ${tip.hash.slice(0, 12)}… → job for height ${template.height}`);
	}

	/**
	 * 30s fee refresh: rebuild the job for the CURRENT tip with fresh mempool
	 * fees (cleanJobs:false -- miners fold it in without discarding in-flight
	 * work). A no-op before the first tip. If the chain moved under us, the
	 * template's prev won't match the tip and we skip (the next real tip
	 * rebuilds).
	 */
	private async refreshJob(): Promise<void> {
		if (this.stopping || this.currentTip === null) return;
		const tip = this.currentTip;
		let template: GbtTemplate;
		try {
			template = await this.getBlockTemplate();
			this.lastTemplateOk = true;
		} catch (err) {
			this.lastTemplateOk = false;
			this.log(`fee-refresh getblocktemplate failed (transient): ${String(err)}`);
			return;
		}
		if (template.previousblockhash !== tip.hash || template.height !== tip.height + 1) {
			// Chain advanced since the last tip event; leave the job to the next tip.
			return;
		}
		this.installJob(template, false);
	}

	/** Build the job for a template and hand it to the Stratum server(s). */
	private installJob(template: GbtTemplate, cleanJobs: boolean): void {
		const jobId = `${this.jobPrefix}${(++this.jobCounter).toString(16).padStart(4, '0')}`;
		const built = buildJob(template, {
			network: this.config.network,
			poolTag: this.config.poolTag,
			jobId,
			cleanJobs
		});
		this.jobsById.set(jobId, built);
		while (this.jobsById.size > JOB_RETENTION) {
			const oldest = this.jobsById.keys().next().value as string;
			this.jobsById.delete(oldest);
		}
		this.lastJobAt = Date.now();
		// Every listener mines the same job (same jobId, same merkle branches,
		// each connection personalized by its own frozen payout inside the
		// listener). handleSolve resolves by jobId regardless of which listener
		// the solve came from.
		this.server.setJob(built);
		this.asicServer?.setJob(built);
	}

	// ------------------------------------------------------------------ solves

	private async handleSolve(e: SolveEvent): Promise<void> {
		if (this.stopping) return;
		const built = this.jobsById.get(e.jobId);
		if (built === undefined) {
			this.log(`solve for unknown/evicted job ${e.jobId} — dropped`);
			return;
		}
		// Re-personalize with the FROZEN payout the winning connection ground
		// (per-miner coinbases differ, so this must be the solver's own script)
		// and assemble the exact winning block.
		const payoutScript = Buffer.from(e.payoutScriptHex, 'hex');
		const variant = built.personalize({ payoutScript });
		const assembled = variant.assemble(e.extranonce1Hex, e.extranonce2Hex, e.ntimeHex, e.nonceHex);
		// Load-bearing: the block we assemble must hash to exactly what the miner
		// found. A mismatch means the frozen payout / job diverged -- never submit.
		if (assembled.blockHashDisplay !== e.hashDisplay) {
			this.invariant(
				`assembled block hash ${assembled.blockHashDisplay} != solve hash ${e.hashDisplay} (job ${e.jobId})`
			);
			return;
		}
		let result: string | null;
		try {
			result = (await this.opts.rpc.call<string | null | undefined>('submitblock', [assembled.blockHex])) ?? null;
		} catch (err) {
			this.log(`submitblock RPC failed (transient): ${String(err)}`);
			return;
		}
		if (result === null) {
			this.log(
				`block ACCEPTED height=${e.height} hash=${assembled.blockHashDisplay.slice(0, 16)}… ` +
					`miner=${e.address} (user ${e.userId} wallet ${e.walletId})`
			);
			this.opts.onBlockAccepted?.(e, assembled.blockHashDisplay, assembled.coinbaseTxidDisplay);
		} else {
			// String result = bitcoind's rejection reason. Loud, but non-fatal:
			// stale solves racing a fresh tip are an expected condition.
			this.log(
				`block REJECTED (${result}) height=${e.height} hash=${assembled.blockHashDisplay.slice(0, 16)}… — non-fatal`
			);
			this.opts.onBlockRejected?.(e, result);
		}
	}
}
