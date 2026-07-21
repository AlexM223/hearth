/**
 * Block watcher (DECISIONS.md §4.5): Electrum headers subscription is the
 * primary source of new-tip pushes; when Electrum is unreachable it falls
 * back to Core RPC polling, so the SSE `block` topic keeps flowing either
 * way. Publishes via the event bus -- never reads SQLite (the bus's own
 * invariant), just the two node rails.
 */
import type { NodeClient } from './index.js';
import { getBlockCount } from './core/rpc.js';
import { publish } from '../events/index.js';
import { log, logWarn } from '../log.js';

export interface BlockWatcherOptions {
	/** Core RPC poll interval while Electrum is down (default 20s). */
	pollIntervalMs?: number;
}

export interface BlockWatcher {
	stop(): void;
}

export function startBlockWatcher(node: NodeClient, opts: BlockWatcherOptions = {}): BlockWatcher {
	const pollIntervalMs = opts.pollIntervalMs ?? 20_000;
	let lastHeight: number | null = null;
	let pollTimer: NodeJS.Timeout | null = null;
	let stopped = false;

	function publishBlock(height: number, source: 'electrum' | 'core-poll'): void {
		if (lastHeight !== null && height <= lastHeight) return;
		lastHeight = height;
		log('block-watcher', { event: 'new_tip', height, source });
		publish('block', { kind: 'broadcast' }, { height });
	}

	function startPolling(): void {
		if (pollTimer || stopped) return;
		log('block-watcher', { event: 'core_poll_fallback_started', pollIntervalMs });
		pollTimer = setInterval(() => {
			getBlockCount(node.coreRpc)
				.then((height) => publishBlock(height, 'core-poll'))
				.catch((e: unknown) => {
					logWarn('block-watcher', { event: 'core_poll_failed', err: String(e) });
				});
		}, pollIntervalMs);
		pollTimer.unref?.();
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	node.electrum.on('header', (header: { height: number }) => {
		stopPolling();
		publishBlock(header.height, 'electrum');
	});
	node.electrum.on('connect', () => stopPolling());
	node.electrum.on('disconnect', () => startPolling());

	node.electrum
		.headersSubscribe()
		.then((header) => publishBlock(header.height, 'electrum'))
		.catch((e: unknown) => {
			logWarn('block-watcher', { event: 'electrum_subscribe_failed', err: String(e) });
			startPolling();
		});

	return {
		stop() {
			stopped = true;
			stopPolling();
		}
	};
}
