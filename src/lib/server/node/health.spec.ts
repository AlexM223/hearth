import { describe, expect, it } from 'vitest';
import { describeNodeHealth, type NodeHealth } from './index.js';

function health(overrides: Partial<NodeHealth> = {}): NodeHealth {
	return {
		electrum: 'connected',
		core: 'connected',
		tipHeight: 934_197,
		syncProgress: null,
		blocksRemaining: null,
		peerCount: 8,
		mempool: { txCount: 100, bytes: 50_000 },
		...overrides
	};
}

describe('node: describeNodeHealth (plain-language copy, DECISIONS.md §4.2/competitor-brief §7)', () => {
	it('reports "Synced" with the tip height when fully synced', () => {
		expect(describeNodeHealth(health())).toBe('Synced · block 934,197');
	});

	it('reports a syncing percentage and ETA when in initial block download', () => {
		const text = describeNodeHealth(
			health({ syncProgress: 0.62, blocksRemaining: 18, tipHeight: 500_000 })
		);
		expect(text).toMatch(/^Syncing 62% —/);
	});

	it('reports unreachable when both rails are down', () => {
		expect(
			describeNodeHealth(health({ electrum: 'down', core: 'down', tipHeight: null }))
		).toMatch(/unreachable/i);
	});

	it('never says "unreachable" when at least one rail answered with a tip', () => {
		const text = describeNodeHealth(health({ core: 'down' }));
		expect(text).not.toMatch(/unreachable/i);
	});
});
