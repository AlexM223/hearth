/**
 * The mempool SSE ticker (EXPLORER.md §5, T8) -- a new publisher on the
 * existing `mempool` topic (DECISIONS.md §4.5: no new topics). Gated on
 * `connectionCount() > 0` (idle-cost-zero) since the bus doesn't track
 * per-topic subscriber counts today -- a deliberately small scope choice,
 * reusing the whole-bus gate rather than adding one. Refreshes the fee
 * histogram + recommendation (warming their existing 8s/30s TTL caches,
 * §1.8) and publishes the lightweight `{ satPerVb, txCount }` broadcast the
 * explorer index's flow chart + fee headline update live from.
 *
 * Hard invariant preserved (DECISIONS.md §4.5): the fee data is computed
 * (via the Electrum/Core rails) BEFORE `publish()` is called -- `publish()`
 * itself never reads SQLite or does any I/O.
 */
import { getMempoolSummary, getFeeHistogram, type MempoolCoreRail, type MempoolElectrumRail } from './mempool.js';
import { getFeeRecommendation, type FeesNode } from './fees.js';
import { connectionCount, publish } from '../events/index.js';
import { logWarn } from '../log.js';

export type MempoolTickerNode = MempoolCoreRail & MempoolElectrumRail & FeesNode;

export interface MempoolTicker {
	stop(): void;
}

const DEFAULT_INTERVAL_MS = 8_000; // matches the mempool summary/histogram TTL, §1.8

export function startMempoolTicker(
	node: MempoolTickerNode,
	intervalMs: number = DEFAULT_INTERVAL_MS
): MempoolTicker {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function tick(): Promise<void> {
		if (stopped) return;
		if (connectionCount() > 0) {
			try {
				const [summary, , feesResult] = await Promise.allSettled([
					getMempoolSummary(node),
					getFeeHistogram(node),
					getFeeRecommendation(node)
				]);
				const txCount = summary.status === 'fulfilled' ? summary.value.txCount : null;
				const satPerVb = feesResult.status === 'fulfilled' ? feesResult.value.satPerVb : null;
				if (txCount !== null || satPerVb !== null) {
					publish('mempool', { kind: 'broadcast' }, { satPerVb, txCount });
				}
			} catch (e) {
				logWarn('chain', { event: 'mempool_ticker_failed', err: String(e) });
			}
		}
		if (stopped) return;
		timer = setTimeout(() => void tick(), intervalMs);
		timer.unref?.();
	}

	void tick();

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
		}
	};
}
