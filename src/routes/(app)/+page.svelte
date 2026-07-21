<script lang="ts">
	import { onMount } from 'svelte';
	import { formatSats } from '$lib/format.js';
	import type { PageProps } from './$types';

	// Home = the hearth (DECISIONS.md §4.2): live tip height, plain-language
	// node health, the watchtower feed, and the first-30-seconds choreography
	// (COME-ABOARD.md §2.5). Owner/Member hero is their own wallet balance;
	// a Guest (or a fresh Member with no wallet yet) sees the aboard message.

	let { data }: PageProps = $props();

	let welcomeDismissed = $state(false);
	let showWelcome = $derived(data.showWelcome && !welcomeDismissed);

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

{#if showWelcome}
	<section class="panel welcome hairline">
		<p class="t-label welcome-text">
			{#if data.user?.role === 'guest'}
				Welcome aboard, {data.user?.username}. You've got a read-only seat by the fire — here's the
				shared view.
			{:else}
				Welcome aboard, {data.user?.username}. Add your wallet to start watching your money — you
				keep the keys, this node keeps watch.
			{/if}
		</p>
		<form method="POST" action="?/dismissWelcome" onsubmit={() => (welcomeDismissed = true)}>
			<button class="dismiss" type="submit" aria-label="Dismiss">&times;</button>
		</form>
	</section>
{/if}

<section class="hero panel">
	<p class="t-micro">The hearth</p>
	{#if data.heroKind === 'aboard'}
		<p class="t-hero aboard">You're aboard {data.captain}'s node</p>
		<p class="status t-label">Come navigate Bitcoin with me.</p>
	{:else}
		<p class="t-hero">
			{formatSats(data.ownBalance.confirmedSats)} <span class="unit">sats</span>
		</p>
		{#if data.ownBalance.unconfirmedSats > 0}
			<p class="pending t-label">+{formatSats(data.ownBalance.unconfirmedSats)} pending</p>
		{/if}
		<p class="status t-label">Come navigate Bitcoin with me.</p>
	{/if}

	{#if data.heroKind === 'aboard' && data.user?.role === 'member'}
		<div class="actions">
			<a class="btn-primary" href="/wallets">Add your wallet</a>
		</div>
	{:else if data.user?.role !== 'guest'}
		<div class="actions">
			<a class="btn-primary" href="/wallets">Send</a>
			<a class="btn-primary secondary" href="/wallets">Receive</a>
		</div>
	{/if}
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
	.welcome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
		background: var(--surface-elevated);
	}

	.welcome-text {
		color: var(--text);
		margin: 0;
	}

	.welcome form {
		margin: 0;
	}

	.dismiss {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 4px 6px;
	}

	.dismiss:hover {
		color: var(--text);
	}

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

	.aboard {
		font-size: 32px;
		line-height: 1.3;
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

	.actions a {
		text-decoration: none;
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
