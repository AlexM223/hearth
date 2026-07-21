<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	// Home = the hearth (DECISIONS.md §4.2): live tip height, plain-language
	// node health, and the watchtower feed. The wallet balance stays a
	// placeholder until the ONE unified engine lands in M2.

	let { data }: PageProps = $props();

	// Live overrides from the SSE `block` topic, layered on top of the
	// server-rendered snapshot via $derived below -- never captured once at
	// mount, so a later client-side navigation back to Home (fresh `data`)
	// isn't stuck showing a stale push from a previous visit.
	let liveTipHeight = $state<number | null>(null);
	let liveHealthText = $state<string | null>(null);
	let liveElectrumStatus = $state<'unknown' | 'connected' | 'down' | null>(null);

	let tipHeight = $derived(liveTipHeight ?? data.health.tipHeight);
	let healthText = $derived(liveHealthText ?? data.healthText);
	let electrumStatus = $derived(liveElectrumStatus ?? data.health.electrum);
	let coreStatus = $derived(data.health.core);
	// While syncing, a live block bump updates the height but not the headline
	// text (no live sync-percent push in M1; the next full page load picks up
	// the new percentage).
	let syncing = $derived(data.health.syncProgress !== null);

	onMount(() => {
		const source = new EventSource('/api/events');
		source.addEventListener('block', (event: MessageEvent) => {
			try {
				const payload = JSON.parse(event.data) as { height: number };
				if (typeof payload.height !== 'number') return;
				liveTipHeight = payload.height;
				liveElectrumStatus = 'connected';
				if (!syncing) {
					liveHealthText = `Synced · block ${payload.height.toLocaleString('en-US')}`;
				}
			} catch {
				// Ignore malformed frames -- never let a bad push break the page.
			}
		});
		return () => source.close();
	});

	function dotClass(status: 'unknown' | 'connected' | 'down'): string {
		return status === 'connected' ? 'dot-ok' : status === 'down' ? 'dot-down' : 'dot-unknown';
	}
</script>

<section class="hero panel">
	<p class="t-micro">The hearth</p>
	<p class="t-hero">0.00000000 <span class="unit">BTC</span></p>
	<p class="status t-label">Come navigate Bitcoin with me.</p>

	<div class="actions">
		<button class="btn-primary" type="button" disabled>Send</button>
		<button class="btn-primary secondary" type="button" disabled>Receive</button>
	</div>
</section>

<section class="health panel">
	<p class="t-micro">Node</p>
	<p class="health-text t-label">{healthText}</p>
	<div class="rails">
		<span class="rail"><span class="dot {dotClass(electrumStatus)}"></span>Electrum</span>
		<span class="rail"><span class="dot {dotClass(coreStatus)}"></span>Core RPC</span>
		{#if tipHeight !== null}
			<span class="tip t-mono">block {tipHeight.toLocaleString('en-US')}</span>
		{/if}
	</div>
</section>

<section class="feed panel">
	<p class="t-micro">Watchtower</p>
	{#if data.feed.length === 0}
		<p class="t-label empty">No activity yet -- import or create a wallet to start watching.</p>
	{:else}
		<ul class="feed-list">
			{#each data.feed as feedEvent (feedEvent.id)}
				<li class="hairline">
					<span class="t-label">{feedEvent.title}</span>
					{#if feedEvent.body}<span class="t-label muted">{feedEvent.body}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.hero {
		text-align: center;
		margin-bottom: var(--space-4);
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 0.35em;
		color: var(--text-secondary);
		vertical-align: middle;
	}

	.status {
		margin-top: var(--space-1);
	}

	.actions {
		display: flex;
		justify-content: center;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}

	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}

	.health {
		margin-bottom: var(--space-4);
	}

	.health-text {
		color: var(--text);
		font-size: var(--t-title);
		font-weight: 500;
		margin: 4px 0 var(--space-2);
	}

	.rails {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.rail {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--t-label);
		color: var(--text-secondary);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		display: inline-block;
	}

	.dot-ok {
		background: var(--sage);
	}

	.dot-down {
		background: var(--error);
	}

	.dot-unknown {
		background: var(--text-faint);
	}

	.tip {
		margin-left: auto;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.feed .empty {
		color: var(--text-muted);
	}

	.feed-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.feed-list li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-1) 0;
	}

	.feed-list .muted {
		color: var(--text-muted);
	}
</style>
