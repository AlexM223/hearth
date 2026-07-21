<script lang="ts">
	// Advanced: raw mempool histogram + summary (EXPLORER.md §4.1). Reachable
	// from the flow chart's mempool-zone link (§3.2).
	import { formatSats } from '$lib/format.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let maxVsize = $derived(Math.max(1, ...data.histogram.buckets.map((b) => b.vsize)));
</script>

<svelte:head>
	<title>Mempool -- Hearth</title>
</svelte:head>

<section class="panel">
	<a class="back t-label" href="/explorer">← Explorer</a>
	<p class="t-title">Mempool (Advanced)</p>

	{#if data.summary.richness === 'none'}
		<DegradeBanner richness="none" noneMessage="Mempool summary needs Core RPC." />
	{:else}
		<div class="grid">
			<div><span class="t-label muted">Transactions</span><span class="t-label value">{formatSats(data.summary.txCount ?? 0)}</span></div>
			<div><span class="t-label muted">Bytes</span><span class="t-label value">{formatSats(data.summary.bytes ?? 0)}</span></div>
			<div><span class="t-label muted">Total fees</span><span class="t-label value">{formatSats(data.summary.totalFeeSats ?? 0)} sats</span></div>
		</div>
	{/if}

	<p class="t-micro histogram-label">Fee-rate histogram</p>
	{#if data.histogram.richness === 'none'}
		<DegradeBanner richness="none" noneMessage="Fee histogram needs Electrum." />
	{:else if data.histogram.buckets.length === 0}
		<p class="t-label empty">No mempool data.</p>
	{:else}
		<ul class="histogram">
			{#each data.histogram.buckets as bucket (bucket.feeRate)}
				<li class="row">
					<span class="rate t-mono">{bucket.feeRate} sat/vB</span>
					<span class="bar-track">
						<span class="bar" style:width={`${(bucket.vsize / maxVsize) * 100}%`}></span>
					</span>
					<span class="vsize t-label">{formatSats(bucket.vsize)} vB</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-3);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0 var(--space-4);
	}

	.grid > div {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.muted {
		color: var(--text-muted);
	}

	.value {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.histogram-label {
		margin-bottom: var(--space-2);
	}

	.histogram {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 6px 0;
	}

	.rate {
		width: 80px;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.bar-track {
		flex: 1;
		height: 8px;
		background: var(--surface-elevated);
		border-radius: 4px;
		overflow: hidden;
	}

	.bar {
		display: block;
		height: 100%;
		background: var(--fee-3);
		border-radius: 4px;
	}

	.vsize {
		width: 100px;
		text-align: right;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.empty {
		color: var(--text-muted);
	}
</style>
