<script lang="ts">
	// The none|basic|full degrade banner (EXPLORER.md §3.7, §6): a page is
	// never wholly blank because one datum's rail is down -- this renders the
	// calm, plain-English explanation per tier. richness:'full' renders
	// nothing (normal rendering, no banner).
	type Richness = 'none' | 'basic' | 'full';

	let {
		richness,
		basicMessage = 'Some detail needs a working node connection -- showing what’s available.',
		noneMessage = "This needs a working node connection -- check Settings."
	}: {
		richness: Richness;
		basicMessage?: string;
		noneMessage?: string;
	} = $props();
</script>

{#if richness === 'none'}
	<p class="degrade degrade-none t-label">{noneMessage}</p>
{:else if richness === 'basic'}
	<p class="degrade degrade-basic t-label">{basicMessage}</p>
{/if}

<style>
	.degrade {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		padding: 10px var(--space-3);
		margin-bottom: var(--space-3);
		color: var(--text-secondary);
	}

	.degrade-none {
		color: var(--attention);
	}
</style>
