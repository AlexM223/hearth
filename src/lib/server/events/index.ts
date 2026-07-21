/**
 * The in-process event bus + SSE hub (the "liveHub" pattern, DECISIONS.md
 * §4.5, ported from cairn's src/lib/server/liveHub.ts). One multiplexed
 * stream (`GET /api/events`) replaces per-topic endpoints; every connection
 * registers here once, carrying identity derived from its session
 * (userId/isAdmin) plus a `send` closure into its ReadableStream.
 *
 * HARD INVARIANTS (DECISIONS.md §4.5, the two cairn SSE-stall incidents):
 *  - `publish()` never reads SQLite. All data a frame needs must be in hand
 *    before publish() is called.
 *  - Idle-cost-zero: publish() is a no-op with zero connections (the caller
 *    still built `data`, but no JSON.stringify happens; keep expensive
 *    payload construction behind a connectionCount() > 0 guard upstream too
 *    when it's non-trivial, e.g. the mempool ticker).
 */
import { EventEmitter } from 'node:events';

export type EventTopic =
	| 'block'
	| 'mempool'
	| 'health'
	| 'wallet'
	| 'notification'
	| 'mining'
	| 'mining:pool';

/** The scope filter IS the security boundary -- a client can never widen its own scope. */
export type PublishScope =
	| { kind: 'broadcast' }
	| { kind: 'user'; userId: number }
	| { kind: 'admin' };

export interface EventFrame {
	topic: EventTopic;
	scope: PublishScope;
	data: unknown;
	ts: number;
}

/** One live SSE connection. `send` writes a raw SSE frame into its stream. */
export interface LiveConnection {
	userId: number;
	isAdmin: boolean;
	send: (frame: string) => void;
}

class EventBus extends EventEmitter {
	private readonly connections = new Set<LiveConnection>();

	constructor() {
		super();
		// A stray unhandled 'error' emit must never crash the process.
		this.on('error', () => {});
	}

	/** Register a connection; returns an idempotent unregister. */
	register(conn: LiveConnection): () => void {
		this.connections.add(conn);
		return () => {
			this.connections.delete(conn);
		};
	}

	/** Current live connection count (idle-cost-zero check, tests, diagnostics). */
	connectionCount(): number {
		return this.connections.size;
	}

	/**
	 * Fan a fully-built payload out to every connection the scope entitles.
	 * The frame is serialized exactly once. A no-op when there are no
	 * connections. `publish()` MUST NEVER read SQLite (DECISIONS.md §4.5) --
	 * any DB read `data` needed happens once, by the caller, before this runs.
	 */
	publish(topic: EventTopic, scope: PublishScope, data: unknown): void {
		if (this.connections.size === 0) return;
		const frame: EventFrame = { topic, scope, data, ts: Date.now() };
		const sseText = `event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const conn of this.connections) {
			if (scope.kind === 'user' && conn.userId !== scope.userId) continue;
			if (scope.kind === 'admin' && !conn.isAdmin) continue;
			// broadcast: no identity filter.
			try {
				conn.send(sseText);
			} catch {
				// A dead connection must never break fan-out to the others; its own
				// stream teardown removes it from the set via the unregister closure.
			}
		}
		this.emit('frame', frame);
	}
}

export const eventBus = new EventBus();

/** Convenience re-export so route/module code imports one surface. */
export function publish(topic: EventTopic, scope: PublishScope, data: unknown): void {
	eventBus.publish(topic, scope, data);
}

export function register(conn: LiveConnection): () => void {
	return eventBus.register(conn);
}

export function connectionCount(): number {
	return eventBus.connectionCount();
}
