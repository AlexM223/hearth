/**
 * The in-process event bus + SSE hub (the "liveHub" pattern, DECISIONS.md
 * §4.5). Stub for M0 -- the multiplexed `GET /api/events` endpoint and
 * per-connection scope filtering land in M1.
 *
 * Hard invariants carried forward from cairn's two SSE-stall incidents:
 *   - `publish()` never reads SQLite. Any DB read needed to build `data`
 *     happens once, here, before publish is called -- never per connection.
 *   - Idle-cost-zero: no-op when there are zero connections.
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
export type PublishScope = { kind: 'broadcast' } | { kind: 'user'; userId: number } | { kind: 'admin' };

export interface EventFrame {
	topic: EventTopic;
	scope: PublishScope;
	data: unknown;
	ts: number;
}

class EventBus extends EventEmitter {
	/** Builds the frame once and fans it out; SSE connections subscribe to 'frame'. */
	publish(topic: EventTopic, scope: PublishScope, data: unknown): void {
		const frame: EventFrame = { topic, scope, data, ts: Date.now() };
		this.emit('frame', frame);
	}
}

export const eventBus = new EventBus();
