/**
 * Regression coverage for hearth-7hw: the Explorer index previously only
 * self-healed its persisted snapshot on a `block` SSE event, never
 * unconditionally on mount -- so a page load before the first live block
 * (or any wiped snapshot) showed permanent degraded banners even though the
 * live API routes returned full data. `refreshExplorerSnapshotAndReload` is
 * the extracted call-site fix; these tests pin its sequencing and its
 * fail-open behavior so the self-heal call can never regress into a no-op.
 */
import { describe, it, expect, vi } from 'vitest';
import { refreshExplorerSnapshotAndReload } from './explorerRefresh.js';

describe('lib/explorerRefresh: refreshExplorerSnapshotAndReload', () => {
	it('POSTs /api/chain/refresh, then calls invalidateAll -- in that order', async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push(`fetch:${url}:${init?.method}`);
			return new Response('{}', { status: 200 });
		});
		const invalidateAllImpl = vi.fn(async () => {
			calls.push('invalidateAll');
		});

		await refreshExplorerSnapshotAndReload(fetchImpl as unknown as typeof fetch, invalidateAllImpl);

		expect(fetchImpl).toHaveBeenCalledWith('/api/chain/refresh', { method: 'POST' });
		expect(invalidateAllImpl).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(['fetch:/api/chain/refresh:POST', 'invalidateAll']);
	});

	it('still calls invalidateAll when the refresh POST rejects (fail-open, never worse than before)', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('network unreachable');
		});
		const invalidateAllImpl = vi.fn(async () => {});

		await expect(
			refreshExplorerSnapshotAndReload(fetchImpl as unknown as typeof fetch, invalidateAllImpl)
		).resolves.toBeUndefined();

		expect(invalidateAllImpl).toHaveBeenCalledTimes(1);
	});

	it('still calls invalidateAll when the refresh POST resolves with a non-ok response', async () => {
		const fetchImpl = vi.fn(async () => new Response('server error', { status: 503 }));
		const invalidateAllImpl = vi.fn(async () => {});

		await refreshExplorerSnapshotAndReload(fetchImpl as unknown as typeof fetch, invalidateAllImpl);

		expect(invalidateAllImpl).toHaveBeenCalledTimes(1);
	});
});
