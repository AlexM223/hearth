<script lang="ts">
	import { formatSats } from '$lib/format.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import FeeChip from '$lib/components/FeeChip.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<section class="panel">
	<div class="head">
		<a class="back t-label" href="/explorer">← Explorer</a>
		<p class="t-title">All blocks</p>
	</div>

	{#if data.blocks.length === 0}
		<DegradeBanner richness="none" noneMessage="No block data yet -- check your node connection." />
	{:else}
		<ul class="block-list">
			{#each data.blocks as block (block.hash)}
				<li class="hairline">
					<a class="row" href={`/explorer/block/${block.hash}`}>
						<span class="height t-mono">{formatSats(block.height)}</span>
						{#if block.pool}
							<span class="pool-badge" title={`Found by ${block.pool.finderDisplayName}`}>⛏</span>
						{/if}
						<span class="hash t-mono">{block.hash.slice(0, 16)}…</span>
						<span class="tx-count t-label">{block.txCount !== null ? `${formatSats(block.txCount)} txs` : '—'}</span>
						<FeeChip feeRate={block.medianFeeRate} />
						<span class="time t-label">{new Date(block.time * 1000).toLocaleString()}</span>
					</a>
				</li>
			{/each}
		</ul>
		{#if data.nextBefore !== null}
			<a class="btn-primary secondary more" href={`/explorer/blocks?before=${data.nextBefore}`}>Load older blocks</a>
		{/if}
	{/if}
</section>

<style>
	.head {
		margin-bottom: var(--space-3);
	}

	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-2);
	}

	.block-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
		text-decoration: none;
		color: var(--text);
	}

	.row:hover {
		color: var(--accent);
	}

	.height {
		min-width: 80px;
		font-variant-numeric: tabular-nums;
	}

	.hash {
		color: var(--text-muted);
		flex: 1;
	}

	.pool-badge {
		color: var(--sage);
	}

	.tx-count {
		color: var(--text-secondary);
		min-width: 90px;
	}

	.time {
		color: var(--text-muted);
		min-width: 160px;
		text-align: right;
	}

	.more {
		display: block;
		text-align: center;
		text-decoration: none;
		margin-top: var(--space-3);
	}

	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}
</style>
