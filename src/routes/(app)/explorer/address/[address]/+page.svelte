<script lang="ts">
	// Address detail (EXPLORER.md §3.5): balance at .t-title scale (never
	// .t-hero/serif -- that's the wallet balance's alone), a paginated
	// history list signed +/- with the wallet's own received/sent colors.
	import { formatSats } from '$lib/format.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import FeeChip from '$lib/components/FeeChip.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let copied = $state(false);
	// svelte-ignore state_referenced_locally -- seeded once, "load more" appends client-side
	let rows = $state(data.page?.rows ?? []);
	// svelte-ignore state_referenced_locally
	let cursor = $state(data.page?.cursor ?? null);
	// svelte-ignore state_referenced_locally
	let hasMore = $state(data.page?.hasMore ?? false);
	let loadingMore = $state(false);

	async function copyAddress() {
		try {
			await navigator.clipboard.writeText(data.address);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// not fatal -- no clipboard permission
		}
	}

	async function loadMore() {
		if (!cursor) return;
		loadingMore = true;
		try {
			const res = await fetch(`/api/chain/address/${data.address}?cursor=${cursor}&limit=25`);
			if (!res.ok) return;
			const body = (await res.json()) as { page: typeof data.page };
			if (!body.page) return;
			rows = [...rows, ...body.page.rows];
			cursor = body.page.cursor;
			hasMore = body.page.hasMore;
		} finally {
			loadingMore = false;
		}
	}
</script>

<section class="panel">
	<a class="back t-label" href="/explorer">← Explorer</a>

	{#if !data.view}
		<DegradeBanner richness="none" noneMessage="This address needs a working node connection -- check Settings." />
	{:else}
		<p class="t-micro">Address</p>
		<p class="t-title balance">{formatSats(data.view.confirmedSats)} <span class="unit">sats</span></p>
		{#if data.view.unconfirmedSats > 0}
			<p class="t-label pending">+{formatSats(data.view.unconfirmedSats)} pending</p>
		{/if}

		<div class="addr-row">
			<span class="t-mono addr">{data.address}</span>
			<button class="copy-btn t-label" type="button" onclick={copyAddress}>{copied ? 'Copied' : 'Copy'}</button>
		</div>
		<p class="t-label muted script-type">{data.view.scriptType ?? 'unknown script type'}</p>

		{#if data.view.richness === 'basic'}
			<DegradeBanner richness="basic" basicMessage="Full history needs Electrum -- showing current balance only." />
		{/if}

		{#if data.view.historyAvailable}
			<div class="history">
				<p class="t-micro">History</p>
				{#if rows.length === 0}
					<p class="t-label empty">No transactions yet.</p>
				{:else}
					<ul class="tx-list">
						{#each rows as row (row.txid)}
							<li class="hairline row">
								<span class="delta t-label" class:recv={row.deltaSats !== null && row.deltaSats > 0}>
									{row.deltaSats === null ? '—' : `${row.deltaSats > 0 ? '+' : ''}${formatSats(row.deltaSats)}`}
								</span>
								<a class="txid t-mono" href={`/explorer/tx/${row.txid}`}>{row.txid.slice(0, 16)}…</a>
								<span class="height t-label">{row.height > 0 ? `block ${formatSats(row.height)}` : 'unconfirmed'}</span>
								<FeeChip feeRate={row.feeRate} />
							</li>
						{/each}
					</ul>
					{#if hasMore}
						<button class="btn-primary secondary more" type="button" onclick={loadMore} disabled={loadingMore}>
							{loadingMore ? 'Loading…' : 'Load more'}
						</button>
					{/if}
				{/if}
			</div>
		{/if}
	{/if}
</section>

<style>
	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-3);
	}

	.balance {
		font-variant-numeric: tabular-nums;
		margin: 4px 0;
	}

	.unit {
		font-size: 0.5em;
		color: var(--text-secondary);
	}

	.pending {
		color: var(--sage);
	}

	.addr-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.addr {
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

	.script-type {
		margin-top: 4px;
	}

	.muted {
		color: var(--text-muted);
	}

	.history {
		margin-top: var(--space-4);
	}

	.empty {
		color: var(--text-muted);
	}

	.tx-list {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
		flex-wrap: wrap;
		row-gap: 4px;
	}

	.delta {
		min-width: 90px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	.delta.recv {
		color: var(--sage);
	}

	.txid {
		color: var(--text-secondary);
		flex: 1;
		text-decoration: none;
	}

	.txid:hover {
		color: var(--accent);
	}

	.height {
		color: var(--text-muted);
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
