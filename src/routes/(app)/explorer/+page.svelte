<script lang="ts">
	// Explorer index: the mempool -> block flow (the teaching metaphor,
	// EXPLORER.md §3.2), the one glanceable fee number (§3.1), and a
	// readable recent-blocks strip. Own-node only, no third-party API ever.
	import { onMount } from 'svelte';
	import { formatSats } from '$lib/format.js';
	import { bucketFeeHistogram, type FeeBand } from '$lib/explorerFlow.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let tiersOpen = $state(false);
	let bands = $state<FeeBand[]>(bucketFeeHistogram([]));
	// svelte-ignore state_referenced_locally -- intentional: seeds from the
	// server-loaded snapshot, then the onMount fetch below overwrites it live.
	let mempoolRichness = $state<'none' | 'basic' | 'full'>(data.mempool?.richness ?? 'none');

	// The fee histogram isn't part of the persisted snapshot (it's a live,
	// fast-changing datum, §1.8) -- fetched client-side so the page's own
	// load() stays rail-free (the SWR contract).
	onMount(async () => {
		try {
			const res = await fetch('/api/chain/mempool');
			if (!res.ok) return;
			const body = (await res.json()) as {
				histogram: { richness: 'none' | 'basic' | 'full'; buckets: { feeRate: number; vsize: number }[] };
			};
			bands = bucketFeeHistogram(body.histogram.buckets);
			mempoolRichness = body.histogram.richness;
		} catch {
			// The flow chart's mempool zone stays empty -- never a crash.
		}
	});

	// Right-to-left: newest immediately right of the divider (index 0), older
	// blocks extend further right and fade.
	let blocks = $derived(data.recentBlocks.slice(0, 6));
	const tileWidth = 76;
	const dividerX = 540;

	function feeCaption(): string {
		if (!data.fees) return 'Fee estimate needs a working node connection.';
		return data.fees.caption;
	}
</script>

<section class="panel fee-headline">
	<p class="t-micro">Fee to send</p>
	{#if data.fees}
		<p class="t-stat">{data.fees.satPerVb} sat/vB</p>
		<p class="t-label caption">{feeCaption()}</p>
		{#if data.fees.richness === 'basic'}
			<DegradeBanner richness="basic" basicMessage="Only one rail answered -- this estimate may be less precise." />
		{/if}
		<button class="tiers-toggle t-label" type="button" onclick={() => (tiersOpen = !tiersOpen)}>
			{tiersOpen ? '− Hide' : '+ Show more'} fee tiers
		</button>
		{#if tiersOpen}
			<ul class="tiers">
				{#each data.fees.tiers as tier (tier.label)}
					<li class="hairline">
						<span class="t-label">{tier.label}</span>
						<span class="tier-rate t-mono">{tier.satPerVb} sat/vB</span>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<DegradeBanner richness="none" />
	{/if}
</section>

<section class="panel flow">
	<p class="t-micro">Mempool → confirmed</p>
	<svg viewBox="0 0 900 200" role="img" aria-label="Mempool to confirmed-block flow, fee-rate colored">
		<!-- mempool zone: 5 fee-band lanes, economy leftmost, priority closest to the divider -->
		{#each bands as band, i (band.tier)}
			{@const laneX = 20 + i * 100}
			{@const squareSize = 3}
			{@const gap = 1}
			<text x={laneX + 40} y="18" class="lane-label" text-anchor="middle">{band.label}</text>
			{#each Array.from({ length: band.squares }) as _, s (s)}
				<rect
					x={laneX + 40 - squareSize / 2}
					y={172 - s * (squareSize + gap)}
					width={squareSize}
					height={squareSize}
					fill={`var(--fee-${band.tier})`}
				/>
			{/each}
			{#if band.overflowVsize > 0}
				<text x={laneX + 40} y="28" class="overflow-label" text-anchor="middle">
					+{formatSats(band.overflowVsize)} vB more
				</text>
			{/if}
		{/each}
		{#if mempoolRichness === 'none'}
			<text x="270" y="100" class="empty-label" text-anchor="middle">Mempool view needs Core RPC</text>
		{/if}

		<!-- divider -->
		<line x1={dividerX} y1="10" x2={dividerX} y2="180" class="divider" />
		<text x={dividerX - 30} y="195" class="zone-label" text-anchor="middle">mempool</text>
		<text x={dividerX + 30} y="195" class="zone-label" text-anchor="middle">confirmed</text>

		<!-- confirmed blocks: newest immediately right of the divider -->
		{#each blocks as block, i (block.hash)}
			{@const x = dividerX + 20 + i * tileWidth}
			<a href={`/explorer/block/${block.hash}`}>
				<rect
					x={x}
					y="60"
					width="64"
					height="64"
					rx="8"
					class="block-tile"
					class:pool-found={block.pool !== null}
					style:opacity={1 - i * 0.12}
				/>
				<text x={x + 32} y="96" class="block-height" text-anchor="middle">{block.height}</text>
			</a>
		{/each}
	</svg>
</section>

<section class="panel recent-blocks">
	<div class="recent-blocks-head">
		<p class="t-micro">Recent blocks</p>
		<a class="see-all t-label" href="/explorer/blocks">See all →</a>
	</div>
	{#if data.recentBlocks.length === 0}
		<DegradeBanner richness="none" noneMessage="No recent-block data yet -- check your node connection." />
	{:else}
		<ul class="block-list">
			{#each data.recentBlocks as block (block.hash)}
				<li class="hairline">
					<a class="block-row" href={`/explorer/block/${block.hash}`}>
						<span class="height t-mono">{formatSats(block.height)}</span>
						{#if block.pool}
							<span class="pool-badge" title={`Found by ${block.pool.finderDisplayName}`}>⛏</span>
						{/if}
						<span class="tx-count t-label">{block.txCount !== null ? `${formatSats(block.txCount)} txs` : '—'}</span>
						<span class="fee-range t-label">
							{block.feeRateRange ? `${Math.round(block.feeRateRange[0])}–${Math.round(block.feeRateRange[1])} sat/vB` : '—'}
						</span>
						<span class="time t-label">{new Date(block.time * 1000).toLocaleTimeString()}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.fee-headline {
		text-align: center;
		margin-bottom: var(--space-4);
	}

	.caption {
		margin-top: 4px;
	}

	.tiers-toggle {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		margin-top: var(--space-2);
		font-family: var(--font-ui);
	}

	.tiers {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		text-align: left;
		max-width: 320px;
		margin-inline: auto;
	}

	.tiers li {
		display: flex;
		justify-content: space-between;
		padding: 6px 0;
	}

	.tier-rate {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.flow {
		margin-bottom: var(--space-4);
	}

	svg {
		width: 100%;
		height: auto;
		margin-top: var(--space-2);
	}

	.lane-label,
	.zone-label,
	.overflow-label,
	.empty-label {
		font-family: var(--font-ui);
		font-size: 8px;
		fill: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.divider {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	.block-tile {
		fill: var(--surface-elevated);
		stroke: var(--border-subtle);
		stroke-width: 1;
	}

	.block-tile.pool-found {
		stroke: var(--sage);
		stroke-width: 2;
	}

	.block-height {
		font-family: var(--font-mono);
		font-size: 9px;
		fill: var(--text-secondary);
	}

	.recent-blocks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-2);
	}

	.see-all {
		color: var(--text-secondary);
		text-decoration: none;
	}

	.see-all:hover {
		color: var(--accent);
	}

	.block-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.block-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
		text-decoration: none;
		color: var(--text);
	}

	.block-row:hover {
		color: var(--accent);
	}

	.height {
		min-width: 80px;
		font-variant-numeric: tabular-nums;
	}

	.pool-badge {
		color: var(--sage);
	}

	.tx-count,
	.fee-range {
		color: var(--text-secondary);
		min-width: 100px;
	}

	.time {
		margin-left: auto;
		color: var(--text-muted);
	}
</style>
