/**
 * Stratum V1 TCP server for the Hearth SOLO mining engine (MINING-ENGINE.md
 * §2, §3, §4).
 *
 * Near-verbatim port of the Tessera pool Stratum server
 * (C:\dev\raffle\pool\src\stratum.ts), via cairn's mining/stratum.ts, with the
 * raffle finder/registry machinery removed and multi-user solo authorization
 * kept. Retained hardening:
 *  - JSON-lines framing via wire.makeLineSplitter (16KB cap, destroy on overflow).
 *  - mining.subscribe -> per-connection random UNIQUE 4-byte extranonce1; setNoDelay.
 *  - 4-job validity window; (en1:en2:nonce) duplicate rejection; strict hex
 *    validation; ntime must equal the job's; error codes 20-25.
 *  - Per-connection vardiff (x2 / /2, power-of-two snap, clamp
 *    [shareDifficulty, MAX_VARDIFF_DEFAULT], race-free announce-time freeze)
 *    -- the retarget DECISION is `vardiff.ts`'s pure `decideRetarget`; the
 *    stateful announce-time freeze/rate-window bookkeeping stays here.
 *  - Stale-submit rate limit (> staleSubmitLimit STALE in a rolling 60s -> destroy).
 *  - Low-difficulty shares are NOT recorded in the dedupe set.
 *  - Solve gate: hashValue <= min(networkTarget, shareTarget >> blockPolicyShift).
 *  - Loopback-only bind default; maxConnections default 128.
 *
 * SOLO model (MINING-ENGINE.md §3.1, §3.3):
 *  (a) authorize parses `<miningId>.<workerName>` (worker defaults 'default',
 *      password ignored) and resolves the miningId via an injected AuthProvider --
 *      an unknown/revoked miningId is rejected UNAUTHORIZED (24).
 *  (b) per-connection per-jobId FROZEN payout: conn.jobPayout records the miner's
 *      MinerAuth at notify time (pruned with the job window). A submit validates
 *      against that frozen entry's personalized coinbase -- mirroring the vardiff
 *      jobDifficulty freeze -- so a wallet change after announce can never move a
 *      block already being ground.
 *  (c) setJob sends each authorized connection ITS OWN mining.notify with its
 *      personalized coinb1/coinb2 (shared jobId + shared merkle branches).
 *  (d) typed ShareEvent / SolveEvent / RejectEvent callbacks.
 *  (e) no finder-registry / finder-bounty machinery.
 *  (f) the socket data handler is wrapped so no parser/personalize throw can
 *      escape and crash the in-process web server (invariant 4).
 *
 * All byte-order and target math is imported from wire.ts -- never reimplemented.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { validateAddressEncodable } from './address.js';
import type {
	AuthProvider,
	BuiltJob,
	ConnectionInfo,
	MinerAuth,
	Network,
	RejectEvent,
	ShareEvent,
	SolveEvent
} from './types.js';
import {
	bitsToTarget,
	difficultyToTarget,
	hashValueFromDisplay,
	headerHashDisplay,
	makeLineSplitter,
	weightForDifficulty
} from './wire.js';
import { decideRetarget, normalizeVardiffOptions, type NormalizedVardiff, type VardiffOptions } from './vardiff.js';

export type { VardiffOptions } from './vardiff.js';

export interface StratumServerOptions {
	readonly port: number;
	/** Bind host. Default '127.0.0.1' (loopback only). '0.0.0.0' admits LAN miners. */
	readonly host?: string;
	/** Fixed share difficulty when `vardiff` is absent; else the vardiff floor + start. */
	readonly shareDifficulty: number;
	readonly network: Network;
	/** Synchronous, zero-I/O resolver from miningId -> MinerAuth. */
	readonly authProvider: AuthProvider;
	readonly onShare: (e: ShareEvent) => void;
	readonly onSolve: (e: SolveEvent) => void;
	/** Optional rejected-submit sink (observability / abuse signal). */
	readonly onReject?: (e: RejectEvent) => void;
	/** Optional structured logger (a parser throw is logged, never thrown). */
	readonly log?: (msg: string) => void;
	/** Regtest-only test knob; 0 disables (production semantics). Default 0. */
	readonly blockPolicyShift?: number;
	/** Per-connection variable difficulty. ABSENT = fixed difficulty. */
	readonly vardiff?: VardiffOptions;
	/** Destroy after MORE than this many STALE rejections in a rolling 60s. Default 30. */
	readonly staleSubmitLimit?: number;
	/** Simultaneous-connection cap. Default 128. */
	readonly maxConnections?: number;
}

/** Stratum V1 error codes (de-facto convention). */
export const STRATUM_ERRORS = {
	OTHER: 20,
	STALE_JOB: 21,
	DUPLICATE_SHARE: 22,
	LOW_DIFFICULTY: 23,
	UNAUTHORIZED: 24,
	NOT_SUBSCRIBED: 25
} as const;

const MAX_CONNECTIONS = 128;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_STALE_SUBMIT_LIMIT = 30;
const STALE_WINDOW_MS = 60_000;
/** Share submissions are accepted against the last N notified jobs. */
const JOB_WINDOW = 4;
const EXTRANONCE_BYTES = 4;
const HEX8 = /^[0-9a-fA-F]{8}$/;
/** Production semantics: solve gate = min(networkTarget, shareTarget >> 0) = networkTarget.
 *  A regtest QA harness reaches a solve via a very low shareDifficulty, never a shift. */
const DEFAULT_BLOCK_POLICY_SHIFT = 0;

/** Default worker name when the authorize token carries no `.worker` suffix. */
const DEFAULT_WORKER = 'default';

type MsgId = number | string | null;

/** Difficulty/target/weight in force for one (connection, jobId) pair. */
interface JobDifficulty {
	readonly difficulty: number;
	readonly target: bigint;
	readonly weight: bigint;
}

interface ConnState {
	readonly socket: Socket;
	/** Assigned at subscribe; unique among live connections. */
	extranonce1: string | null;
	subscriptionId: string | null;
	/** Resolved MinerAuth after a successful authorize; null until then. */
	auth: MinerAuth | null;
	/** Worker name parsed from the authorize token (defaults 'default'). */
	worker: string;
	/** Vardiff: difficulty for the NEXT job announced to this connection. */
	difficulty: number;
	/** Vardiff: jobId -> difficulty recorded when the job was announced (race-free). */
	readonly jobDifficulty: Map<string, JobDifficulty>;
	/**
	 * Solo: jobId -> the MinerAuth FROZEN when the job was announced to this
	 * connection. A submit re-personalizes and validates against this exact
	 * payout, never the connection's live auth -- so a wallet change after the
	 * announce cannot move a block already being ground. Pruned with the window.
	 */
	readonly jobPayout: Map<string, MinerAuth>;
	/** Vardiff: accepted-share timestamps since the last adjustment, pruned to windowMs. */
	readonly shareTimes: number[];
	lastAdjustAt: number;
	lastAnnouncedDifficulty: number | null;
	/** STALE_JOB rejection timestamps, pruned to a rolling STALE_WINDOW_MS. */
	readonly staleTimes: number[];
	/** Lifetime accepted-share count on this connection (status projection). */
	sharesAccepted: number;
	lastShareAt: number | null;
}

export class StratumServer {
	private readonly opts: StratumServerOptions;
	private readonly server: Server;
	private readonly shareTarget: bigint;
	private readonly policyShift: bigint;
	private readonly vd: NormalizedVardiff | null;
	private readonly staleSubmitLimit: number;
	private readonly log: (msg: string) => void;
	private readonly conns = new Set<ConnState>();
	private readonly usedExtranonce1 = new Set<string>();
	/** Insertion-ordered jobId -> job; pruned to the last JOB_WINDOW entries. */
	private readonly jobs = new Map<string, BuiltJob>();
	/** jobId -> seen "(en1):(en2):(nonce)" keys; pruned with the job window. */
	private readonly seenShares = new Map<string, Set<string>>();
	private currentJob: BuiltJob | null = null;
	private closed = false;

	constructor(opts: StratumServerOptions) {
		this.shareTarget = difficultyToTarget(opts.shareDifficulty);
		// Fail fast on a non-positive / zero-rounding difficulty (matches the target math).
		weightForDifficulty(opts.shareDifficulty);
		const shift = opts.blockPolicyShift ?? DEFAULT_BLOCK_POLICY_SHIFT;
		if (!Number.isInteger(shift) || shift < 0 || shift > 255) {
			throw new Error(`blockPolicyShift must be an integer in [0, 255], got ${shift}`);
		}
		this.policyShift = BigInt(shift);
		this.vd = normalizeVardiffOptions(opts.vardiff, opts.shareDifficulty);
		if (opts.host !== undefined && opts.host.length === 0) {
			throw new Error('host must be a non-empty bind address');
		}
		const staleLimit = opts.staleSubmitLimit ?? DEFAULT_STALE_SUBMIT_LIMIT;
		if (!Number.isInteger(staleLimit) || staleLimit <= 0) {
			throw new Error(`staleSubmitLimit must be a positive integer, got ${staleLimit}`);
		}
		this.staleSubmitLimit = staleLimit;
		this.log = opts.log ?? (() => {});
		this.opts = opts;
		this.server = createServer((socket) => this.onConnection(socket));
	}

	/** Connections that have completed mining.authorize. */
	get minerCount(): number {
		let n = 0;
		for (const c of this.conns) if (c.auth !== null) n++;
		return n;
	}

	/** Per-connection status projection for authorized miners. */
	connections(): ConnectionInfo[] {
		const out: ConnectionInfo[] = [];
		for (const c of this.conns) {
			if (c.auth === null) continue;
			out.push({
				miningId: c.auth.miningId,
				userId: c.auth.userId,
				worker: c.worker,
				address: c.auth.address,
				difficulty: this.vd === null ? this.opts.shareDifficulty : c.difficulty,
				sharesAccepted: c.sharesAccepted,
				lastShareAt: c.lastShareAt
			});
		}
		return out;
	}

	/** Actual bound port (useful when constructed with port 0 in tests). */
	get port(): number {
		const a = this.server.address();
		return a !== null && typeof a === 'object' ? a.port : this.opts.port;
	}

	/** Actual bound address (test/observability hook). */
	get boundAddress(): string | null {
		const a = this.server.address();
		return a !== null && typeof a === 'object' ? a.address : null;
	}

	get listening(): boolean {
		return this.server.listening;
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server.once('error', onError);
			this.server.listen(this.opts.port, this.opts.host ?? DEFAULT_HOST, () => {
				this.server.removeListener('error', onError);
				resolve();
			});
		});
	}

	/** Install a new current job and notify every authorized miner (personalized). */
	setJob(built: BuiltJob): void {
		const jobId = built.job.jobId;
		// Re-announcing an id keeps its dedup set (no double-count on re-set).
		const seen = this.seenShares.get(jobId) ?? new Set<string>();
		this.jobs.delete(jobId);
		this.jobs.set(jobId, built);
		this.seenShares.set(jobId, seen);
		while (this.jobs.size > JOB_WINDOW) {
			const oldest = this.jobs.keys().next().value as string;
			this.jobs.delete(oldest);
			this.seenShares.delete(oldest);
		}
		this.currentJob = built;
		for (const conn of this.conns) {
			if (conn.auth !== null) this.sendDifficultyAndJob(conn, built);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const conn of [...this.conns]) conn.socket.destroy();
		await new Promise<void>((resolve, reject) => {
			if (!this.server.listening) return resolve();
			this.server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	// ---------------------------------------------------------------- wire IO

	private onConnection(socket: Socket): void {
		if (this.closed || this.conns.size >= (this.opts.maxConnections ?? MAX_CONNECTIONS)) {
			socket.destroy();
			return;
		}
		const conn: ConnState = {
			socket,
			extranonce1: null,
			subscriptionId: null,
			auth: null,
			worker: DEFAULT_WORKER,
			difficulty: this.opts.shareDifficulty,
			jobDifficulty: new Map(),
			jobPayout: new Map(),
			shareTimes: [],
			lastAdjustAt: 0,
			lastAnnouncedDifficulty: null,
			staleTimes: [],
			sharesAccepted: 0,
			lastShareAt: null
		};
		this.conns.add(conn);
		socket.setNoDelay(true);
		const onData = makeLineSplitter(
			(line) => {
				// In-process engine: a throw from JSON parsing, personalize, or the
				// wire math must NEVER escape into the socket 'data' listener chain
				// and crash the whole web server (invariant 4). Catch, log, drop.
				try {
					this.handleLine(conn, line);
				} catch (err) {
					this.log(`stratum handler error (connection dropped): ${String(err)}`);
					socket.destroy();
				}
			},
			() => socket.destroy() // capped buffer overflow -> kill the connection
		);
		socket.on('data', onData);
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			this.conns.delete(conn);
			if (conn.extranonce1 !== null) this.usedExtranonce1.delete(conn.extranonce1);
		});
	}

	private send(conn: ConnState, obj: unknown): void {
		if (conn.socket.destroyed || !conn.socket.writable) return;
		conn.socket.write(JSON.stringify(obj) + '\n');
	}

	private respond(conn: ConnState, id: MsgId, result: unknown, error: [number, string, null] | null): void {
		this.send(conn, { id, result, error });
	}

	private reject(conn: ConnState, id: MsgId, code: number, message: string): void {
		this.respond(conn, id, null, [code, message, null]);
	}

	private emitReject(conn: ConnState, reason: RejectEvent['reason']): void {
		if (this.opts.onReject === undefined) return;
		const e: RejectEvent = { reason };
		if (conn.auth !== null) (e as { userId?: number }).userId = conn.auth.userId;
		if (conn.auth !== null) (e as { worker?: string }).worker = conn.worker;
		this.opts.onReject(e);
	}

	/**
	 * Reject a submit as STALE_JOB and rate-limit the rejections: more than
	 * staleSubmitLimit inside a rolling 60s window destroys the connection. Only
	 * STALE_JOB rejections are counted.
	 */
	private rejectStale(conn: ConnState, id: MsgId, message: string): void {
		this.reject(conn, id, STRATUM_ERRORS.STALE_JOB, message);
		this.emitReject(conn, 'stale');
		const now = Date.now();
		conn.staleTimes.push(now);
		const cutoff = now - STALE_WINDOW_MS;
		while (conn.staleTimes.length > 0 && conn.staleTimes[0]! <= cutoff) conn.staleTimes.shift();
		if (conn.staleTimes.length > this.staleSubmitLimit) conn.socket.destroy();
	}

	private sendDifficultyAndJob(conn: ConnState, built: BuiltJob | null): void {
		let difficulty = this.vd === null ? this.opts.shareDifficulty : conn.difficulty;
		if (this.vd !== null && built !== null) {
			const jobId = built.job.jobId;
			const existing = conn.jobDifficulty.get(jobId);
			if (existing !== undefined) {
				// Re-announcing a job this connection already has keeps the original
				// record: the difficulty in force for (connection, jobId) NEVER changes
				// once announced (race-free rule).
				difficulty = existing.difficulty;
			} else {
				conn.jobDifficulty.set(jobId, {
					difficulty,
					target: difficultyToTarget(difficulty),
					weight: weightForDifficulty(difficulty)
				});
				for (const id of conn.jobDifficulty.keys()) {
					if (!this.jobs.has(id)) conn.jobDifficulty.delete(id);
				}
			}
		}
		// Re-base the vardiff rate window when the difficulty this connection mines
		// at actually CHANGES: only the FIRST announce of a genuinely new
		// difficulty re-bases.
		if (this.vd !== null && built !== null && difficulty !== conn.lastAnnouncedDifficulty) {
			if (conn.lastAnnouncedDifficulty !== null) {
				conn.shareTimes.length = 0;
				conn.lastAdjustAt = this.vd.now();
			}
			conn.lastAnnouncedDifficulty = difficulty;
		}
		this.send(conn, { id: null, method: 'mining.set_difficulty', params: [difficulty] });
		if (built === null) return;
		const j = built.job;
		// Solo: freeze THIS connection's payout for THIS job and announce its own
		// personalized coinbase. A submit later validates against exactly this
		// frozen MinerAuth (mirrors the jobDifficulty freeze above).
		const auth = conn.auth!;
		conn.jobPayout.set(j.jobId, auth);
		for (const id of conn.jobPayout.keys()) {
			if (!this.jobs.has(id)) conn.jobPayout.delete(id);
		}
		const variant = built.personalize({ payoutScript: auth.payoutScript });
		this.send(conn, {
			id: null,
			method: 'mining.notify',
			params: [
				j.jobId,
				j.prevHashStratum,
				variant.coinb1Hex,
				variant.coinb2Hex,
				[...j.merkleBranchesInternalHex],
				j.versionHex,
				j.nbitsHex,
				j.ntimeHex,
				j.cleanJobs
			]
		});
	}

	// ------------------------------------------------------------- dispatch

	private handleLine(conn: ConnState, line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			conn.socket.destroy(); // garbage framing -> kill, don't guess
			return;
		}
		if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
			conn.socket.destroy();
			return;
		}
		const m = msg as { id?: unknown; method?: unknown; params?: unknown };
		const id: MsgId = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : null;
		if (typeof m.method !== 'string') {
			this.reject(conn, id, STRATUM_ERRORS.OTHER, 'missing method');
			return;
		}
		const params: unknown[] = Array.isArray(m.params) ? m.params : [];
		switch (m.method) {
			case 'mining.subscribe':
				this.handleSubscribe(conn, id);
				return;
			case 'mining.authorize':
				this.handleAuthorize(conn, id, params);
				return;
			case 'mining.submit':
				this.handleSubmit(conn, id, params);
				return;
			default:
				this.reject(conn, id, STRATUM_ERRORS.OTHER, `unknown method: ${m.method}`);
		}
	}

	private handleSubscribe(conn: ConnState, id: MsgId): void {
		if (conn.extranonce1 === null) {
			let en1: string;
			do {
				en1 = randomBytes(EXTRANONCE_BYTES).toString('hex');
			} while (this.usedExtranonce1.has(en1));
			this.usedExtranonce1.add(en1);
			conn.extranonce1 = en1;
			conn.subscriptionId = randomBytes(4).toString('hex');
		}
		// Re-subscribe is idempotent: same subscription, same extranonce1.
		this.respond(conn, id, [[['mining.notify', conn.subscriptionId]], conn.extranonce1, EXTRANONCE_BYTES], null);
	}

	private handleAuthorize(conn: ConnState, id: MsgId, params: unknown[]): void {
		if (conn.auth !== null) {
			this.respond(conn, id, false, [STRATUM_ERRORS.OTHER, 'already authorized', null]);
			return;
		}
		const token = params[0];
		if (typeof token !== 'string' || token.length === 0) {
			this.respond(conn, id, false, [STRATUM_ERRORS.OTHER, 'missing worker name', null]);
			return;
		}
		// token = "<miningId>" or "<miningId>.<workerName>" -- password (params[1]) ignored.
		const dot = token.indexOf('.');
		const miningId = dot === -1 ? token : token.slice(0, dot);
		const worker = dot === -1 || dot === token.length - 1 ? DEFAULT_WORKER : token.slice(dot + 1);
		const auth = this.opts.authProvider.resolve(miningId);
		if (auth === null) {
			this.emitReject(conn, 'unauthorized');
			this.respond(conn, id, false, [STRATUM_ERRORS.UNAUTHORIZED, 'unknown or revoked mining id', null]);
			return;
		}
		// Defense in depth: the resolved payout address must be encodable on this
		// network (the snapshot provider should already guarantee it).
		if (!validateAddressEncodable(auth.address, this.opts.network)) {
			this.emitReject(conn, 'unauthorized');
			this.respond(conn, id, false, [
				STRATUM_ERRORS.UNAUTHORIZED,
				'payout address is not encodable on this network',
				null
			]);
			return;
		}
		conn.auth = auth;
		conn.worker = worker;
		if (this.vd !== null) conn.lastAdjustAt = this.vd.now(); // rate window starts now
		this.respond(conn, id, true, null);
		this.sendDifficultyAndJob(conn, this.currentJob);
	}

	private handleSubmit(conn: ConnState, id: MsgId, params: unknown[]): void {
		if (conn.auth === null) {
			this.reject(conn, id, STRATUM_ERRORS.UNAUTHORIZED, 'unauthorized worker');
			this.emitReject(conn, 'unauthorized');
			return;
		}
		if (conn.extranonce1 === null) {
			this.reject(conn, id, STRATUM_ERRORS.NOT_SUBSCRIBED, 'not subscribed');
			return;
		}
		const [, jobIdRaw, en2Raw, ntimeRaw, nonceRaw] = params;
		if (
			typeof jobIdRaw !== 'string' ||
			typeof en2Raw !== 'string' ||
			typeof ntimeRaw !== 'string' ||
			typeof nonceRaw !== 'string'
		) {
			this.reject(conn, id, STRATUM_ERRORS.OTHER, 'malformed submit params');
			this.emitReject(conn, 'other');
			return;
		}
		const built = this.jobs.get(jobIdRaw);
		if (built === undefined) {
			this.rejectStale(conn, id, 'job not found (stale)');
			return;
		}
		// Solo: the payout FROZEN when this job was announced to this connection.
		// Absent = the connection authorized after the job was announced (or the
		// job rotated out) -- treat as stale, mirroring the vardiff freeze.
		const frozen = conn.jobPayout.get(jobIdRaw);
		if (frozen === undefined) {
			this.rejectStale(conn, id, 'job was not announced on this connection');
			return;
		}
		// Fixed mode: every share validates at the global difficulty. Vardiff: a
		// share validates AND weighs at the difficulty in force for
		// (connection, jobId) at announce time -- never the latest difficulty.
		let target = this.shareTarget;
		let announceDifficulty = this.opts.shareDifficulty;
		if (this.vd !== null) {
			const rec = conn.jobDifficulty.get(jobIdRaw);
			if (rec === undefined) {
				this.rejectStale(conn, id, 'job was not announced on this connection');
				return;
			}
			target = rec.target;
			announceDifficulty = rec.difficulty;
		}
		if (!HEX8.test(en2Raw)) {
			this.reject(conn, id, STRATUM_ERRORS.OTHER, `extranonce2 must be ${EXTRANONCE_BYTES * 2} hex chars`);
			this.emitReject(conn, 'other');
			return;
		}
		if (!HEX8.test(ntimeRaw)) {
			this.reject(conn, id, STRATUM_ERRORS.OTHER, 'ntime must be 8 hex chars');
			this.emitReject(conn, 'other');
			return;
		}
		const en2 = en2Raw.toLowerCase();
		const ntime = ntimeRaw.toLowerCase();
		if (ntime !== built.job.ntimeHex.toLowerCase()) {
			// No ntime-rolling in M5 -- strict match.
			this.reject(conn, id, STRATUM_ERRORS.OTHER, 'ntime does not match job');
			this.emitReject(conn, 'other');
			return;
		}
		if (!HEX8.test(nonceRaw)) {
			this.reject(conn, id, STRATUM_ERRORS.OTHER, 'nonce must be 8 hex chars');
			this.emitReject(conn, 'other');
			return;
		}
		const nonce = nonceRaw.toLowerCase();
		const en1 = conn.extranonce1;

		const seen = this.seenShares.get(jobIdRaw)!;
		const dedupKey = `${en1}:${en2}:${nonce}`;
		if (seen.has(dedupKey)) {
			this.reject(conn, id, STRATUM_ERRORS.DUPLICATE_SHARE, 'duplicate share');
			this.emitReject(conn, 'duplicate');
			return;
		}

		// Validate against the SAME coinbase this connection was announced (its own
		// frozen payout), never anyone else's -- a share valid for miner A's
		// coinbase is meaningless on a connection paying miner B.
		const variant = built.personalize({ payoutScript: frozen.payoutScript });
		const header = variant.headerFor(en1, en2, ntime, nonce);
		const hashDisplay = headerHashDisplay(header);
		const hashValue = hashValueFromDisplay(hashDisplay);
		if (hashValue > target) {
			// Reject WITHOUT recording the dedup key: only ACCEPTED shares are
			// deduped, bounding set growth by real hashrate (never a no-PoW
			// garbage-flood-grows-seenShares-unbounded hazard).
			this.reject(conn, id, STRATUM_ERRORS.LOW_DIFFICULTY, 'low difficulty share');
			this.emitReject(conn, 'low_difficulty');
			return;
		}
		seen.add(dedupKey); // accepted share recorded -- a resubmit is a DUPLICATE

		this.respond(conn, id, true, null);
		const nowMs = Date.now();
		conn.sharesAccepted++;
		conn.lastShareAt = nowMs;
		this.opts.onShare({
			userId: frozen.userId,
			miningId: frozen.miningId,
			worker: conn.worker,
			difficulty: announceDifficulty,
			timestampMs: nowMs
		});
		this.recordAcceptedShare(conn);

		// Solve gate: submit-worthy only when the hash clears both the consensus
		// target and the shifted share target (the target the share was VALIDATED at).
		const networkTarget = bitsToTarget(built.job.nbitsHex);
		const shifted = target >> this.policyShift;
		const solveTarget = networkTarget < shifted ? networkTarget : shifted;
		if (hashValue <= solveTarget) {
			this.opts.onSolve({
				jobId: jobIdRaw,
				extranonce1Hex: en1,
				extranonce2Hex: en2,
				ntimeHex: ntime,
				nonceHex: nonce,
				hashDisplay,
				height: built.job.height,
				userId: frozen.userId,
				miningId: frozen.miningId,
				worker: conn.worker,
				walletId: frozen.walletId,
				address: frozen.address,
				payoutScriptHex: Buffer.from(frozen.payoutScript).toString('hex'),
				coinbaseValueSats: built.job.coinbaseValueSats
			});
		}
	}

	// -------------------------------------------------------------- vardiff

	private recordAcceptedShare(conn: ConnState): void {
		const vd = this.vd;
		if (vd === null) return;
		const now = vd.now();
		conn.shareTimes.push(now);
		const windowCutoff = now - vd.windowMs;
		while (conn.shareTimes.length > 0 && conn.shareTimes[0]! <= windowCutoff) conn.shareTimes.shift();
		if (now - conn.lastAdjustAt < vd.adjustIntervalMs) return;
		// A decided adjustment only takes effect once ANNOUNCED on a new job (race
		// rule). Hold off until the pending difficulty is announced.
		if (conn.lastAnnouncedDifficulty !== null && conn.difficulty !== conn.lastAnnouncedDifficulty) return;
		const observeMs = Math.min(now - conn.lastAdjustAt, vd.windowMs);
		const next = decideRetarget({
			shareCount: conn.shareTimes.length,
			observeMs,
			currentDifficulty: conn.difficulty,
			targetSharesPerMin: vd.targetSharesPerMin,
			maxDifficulty: vd.maxDifficulty,
			floorDifficulty: this.opts.shareDifficulty
		});
		if (next === null) return;
		conn.difficulty = next;
		conn.lastAdjustAt = now;
		conn.shareTimes.length = 0;
		this.send(conn, { id: null, method: 'mining.set_difficulty', params: [next] });
	}
}
