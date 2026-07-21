/**
 * Client-safe "self-heal" step for the Explorer index (EXPLORER.md §1.8,
 * §4.1) -- no server import, so this can be called directly from
 * `+page.svelte`. `+page.server.ts`'s load() is intentionally rail-free
 * (reads the persisted `explorer_snapshot` row synchronously, the wallet
 * module's own SWR discipline) -- it never calls the live Electrum/Core
 * rails itself. That snapshot is only ever populated by
 * `POST /api/chain/refresh` (server-side `refreshExplorerSnapshot`), so
 * something client-side MUST call it before the page has any live data to
 * show.
 *
 * hearth-7hw: the index page previously only triggered this refresh from
 * the `block` SSE event handler -- never unconditionally on mount. A fresh
 * boot (or any session where a client connects before the next block)
 * therefore rendered the degraded "no node connection" / "no recent-block
 * data" banners *forever*, even though `/api/chain/fees` and
 * `/api/chain/blocks` (which call the same read models directly, no
 * snapshot involved) returned full data the whole time -- a reload doesn't
 * help because the server load() only ever re-reads the same empty/stale
 * snapshot row. Extracted here (rather than inlined in onMount) so the
 * refresh-then-reload sequencing is unit-testable without a component-test
 * harness (none exists in this repo yet).
 */
export async function refreshExplorerSnapshotAndReload(
	fetchImpl: typeof fetch,
	invalidateAllImpl: () => Promise<void>
): Promise<void> {
	try {
		await fetchImpl('/api/chain/refresh', { method: 'POST' });
	} catch {
		// best-effort -- invalidateAll() below still picks up whatever
		// snapshot is currently persisted, never worse than before.
	}
	await invalidateAllImpl();
}
