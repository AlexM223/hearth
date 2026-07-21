<script lang="ts">
	// Block detail (EXPLORER.md §3.3): hairlines not boxes, a label:value
	// grid, a paginated tx list, raw header bytes behind Advanced.
	import { onMount } from 'svelte';
	import { formatSats } from '$lib/format.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import FeeChip from '$lib/components/FeeChip.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let advanced = $state(false);
	let copied = $state(false);
	// svelte-ignore state_referenced_locally -- seeded once, then "load more" appends client-side
	let rows = $state(data.txPage.rows);
	// svelte-ignore state_referenced_locally
	let cursor = $state(data.txPage.cursor);
	// svelte-ignore state_referenced_locally
	let hasMore = $state(data.txPage.hasMore);
	let loadingMore = $state(false);

	// SSE (T8): a still-shallow block's confirmations bump client-side from
	// the `block` frame's height alone -- no refetch needed just to bump a
	// number (EXPLORER.md §4/§7 T8's accept line).
	let liveConfirmations = $state<number | null>(null);
	let confirmations = $derived(liveConfirmations ?? data.detail.confirmations);

	onMount(() => {
		if (data.detail.confirmations === null || data.detail.confirmations >= 6) return;
		const source = new EventSource('/api/events');
		source.addEventListener('block', (event: MessageEvent) => {
			try {
				const payload = JSON.parse(event.data) as { height: number };
				liveConfirmations = payload.height - data.detail.height + 1;
			} catch {
				// ignore malformed frames
			}
		});
		return () => source.close();
	});

	async function copyHash() {
		try {
			await navigator.clipboard.writeText(data.detail.hash);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// clipboard permission denied -- not fatal, just no confirmation flash
		}
	}

	async function loadMoreTxs() {
		loadingMore = true;
		try {
			const res = await fetch(`/api/chain/blocks/${data.detail.hash}/txs?cursor=${cursor}&limit=25`);
			if (!res.ok) return;
			const page = (await res.json()) as typeof data.txPage;
			rows = [...rows, ...page.rows];
			cursor = page.cursor;
			hasMore = page.hasMore;
		} finally {
			loadingMore = false;
		}
	}
</script>

<section class="panel">
	<a class="back t-label" href="/explorer">← Explorer</a>

	{#if data.detail.richness === 'none'}
		<DegradeBanner richness="none" noneMessage="This block needs a working node connection -- check Settings." />
	{:else}
		<div class="header hairline">
			<p class="t-title">Block {formatSats(data.detail.height)}</p>
			<div class="hash-row">
				<span class="hash t-mono">{data.detail.hash}</span>
				<button class="copy-btn t-label" type="button" onclick={copyHash}>{copied ? 'Copied' : 'Copy'}</button>
			</div>
			{#if data.detail.pool}
				<p class="pool-line t-label">
					⛏ {data.detail.pool.isYou ? 'You found this block!' : `Found by this household — ${data.detail.pool.finderDisplayName}`}
				</p>
			{/if}
		</div>
		<div class="header hairline">
			<span class="t-label">Time</span>
			<span class="t-label value">{new Date(data.detail.time * 1000).toLocaleString()}</span>
		</div>
		<div class="header hairline">
			<span class="t-label">Confirmations</span>
			<span class="t-label value">{confirmations ?? '—'}</span>
		</div>

		{#if data.detail.richness === 'basic'}
			<DegradeBanner richness="basic" basicMessage="Fee/size details need Bitcoin Core -- showing what's available." />
		{/if}

		<div class="grid">
			<div><span class="t-label muted">Size</span><span class="t-label value">{data.detail.size !== null ? `${formatSats(data.detail.size)} B` : '—'}</span></div>
			<div><span class="t-label muted">Weight</span><span class="t-label value">{data.detail.weight !== null ? formatSats(data.detail.weight) : '—'}</span></div>
			<div><span class="t-label muted">Transactions</span><span class="t-label value">{data.detail.txCount !== null ? formatSats(data.detail.txCount) : '—'}</span></div>
			<div><span class="t-label muted">Difficulty</span><span class="t-label value">{data.detail.difficulty !== null ? formatSats(Math.round(data.detail.difficulty)) : '—'}</span></div>
			<div><span class="t-label muted">Reward</span><span class="t-label value">{data.detail.reward !== null ? `${formatSats(data.detail.reward)} sats` : '—'}</span></div>
			<div><span class="t-label muted">Fee range</span><span class="t-label value">{data.detail.feeRateRange ? `${Math.round(data.detail.feeRateRange[0])}–${Math.round(data.detail.feeRateRange[1])} sat/vB` : '—'}</span></div>
		</div>

		<button class="adv-toggle t-label" type="button" onclick={() => (advanced = !advanced)}>
			{advanced ? '− Hide' : '+ Show'} advanced
		</button>
		{#if advanced}
			<div class="advanced-grid">
				<div><span class="t-label muted">Merkle root</span><span class="t-mono value">{data.detail.merkleRoot}</span></div>
				<div><span class="t-label muted">Version</span><span class="t-mono value">{data.detail.versionHex}</span></div>
				<div><span class="t-label muted">Bits</span><span class="t-mono value">{data.detail.bits}</span></div>
				<div><span class="t-label muted">Nonce</span><span class="t-mono value">{data.detail.nonce}</span></div>
				<div><span class="t-label muted">Chainwork</span><span class="t-mono value">{data.detail.chainwork ?? '—'}</span></div>
				<div><span class="t-label muted">Previous block</span>
					{#if data.detail.prevHash}
						<a class="t-mono value link" href={`/explorer/block/${data.detail.prevHash}`}>{data.detail.prevHash.slice(0, 20)}…</a>
					{:else}
						<span class="t-mono value">—</span>
					{/if}
				</div>
			</div>
		{/if}

		<div class="txs">
			<p class="t-micro">Transactions</p>
			{#if rows.length === 0}
				<p class="t-label empty">No transaction data available.</p>
			{:else}
				<ul class="tx-list">
					{#each rows as row (row.txid)}
						<li class="hairline">
							<a class="tx-row" href={`/explorer/tx/${row.txid}`}>
								<span class="txid t-mono">{row.txid.slice(0, 20)}…</span>
								<span class="total t-label">{row.totalOut !== null ? `${formatSats(row.totalOut)} sats` : '—'}</span>
								<FeeChip feeRate={row.feeRate} />
							</a>
						</li>
					{/each}
				</ul>
				{#if hasMore}
					<button class="btn-primary secondary more" type="button" onclick={loadMoreTxs} disabled={loadingMore}>
						{loadingMore ? 'Loading…' : 'Load more'}
					</button>
				{/if}
			{/if}
		</div>
	{/if}
</section>

<style>
	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-3);
	}

	.header {
		padding: var(--space-2) 0;
	}

	.hash-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: 4px;
	}

	.hash {
		color: var(--text-secondary);
		word-break: break-all;
	}

	.copy-btn {
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 2px 10px;
		color: var(--text-secondary);
		cursor: pointer;
		white-space: nowrap;
	}

	.pool-line {
		color: var(--sage);
		margin-top: 6px;
	}

	.value {
		color: var(--text);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0;
	}

	.grid > div,
	.advanced-grid > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.muted {
		color: var(--text-muted);
	}

	.adv-toggle {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 0;
		font-family: var(--font-ui);
	}

	.advanced-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0;
	}

	.advanced-grid .value {
		word-break: break-all;
	}

	.link {
		color: var(--accent);
		text-decoration: none;
	}

	.txs {
		margin-top: var(--space-4);
	}

	.empty {
		color: var(--text-muted);
	}

	.tx-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.tx-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
		text-decoration: none;
		color: var(--text);
	}

	.tx-row:hover {
		color: var(--accent);
	}

	.txid {
		color: var(--text-secondary);
		flex: 1;
	}

	.total {
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.more {
		display: block;
		margin: var(--space-3) auto 0;
	}

	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}
</style>
