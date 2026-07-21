<script lang="ts">
	// A small fee-rate chip colored by the SAME --fee-1..5 tokens as the
	// flow chart (EXPLORER.md §3.3) -- visual consistency between the
	// teaching metaphor and every data table (block tx list, tx detail).
	// `feeRate: null` renders a plain dash, never a fabricated color/number.
	function tierFor(feeRate: number): 1 | 2 | 3 | 4 | 5 {
		if (feeRate >= 50) return 5;
		if (feeRate >= 20) return 4;
		if (feeRate >= 10) return 3;
		if (feeRate >= 5) return 2;
		return 1;
	}

	let { feeRate }: { feeRate: number | null } = $props();
	let tier = $derived(feeRate === null ? null : tierFor(feeRate));
</script>

{#if feeRate === null}
	<span class="chip chip-unknown t-label">—</span>
{:else}
	<span class="chip t-label" style:background={`color-mix(in srgb, var(--fee-${tier}) 20%, transparent)`} style:color={`var(--fee-${tier})`}>
		{feeRate < 10 ? feeRate.toFixed(1) : Math.round(feeRate)} sat/vB
	</span>
{/if}

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		font-variant-numeric: tabular-nums;
		border-radius: var(--radius-pill);
		padding: 2px 10px;
		font-weight: 500;
		white-space: nowrap;
	}

	.chip-unknown {
		color: var(--text-faint);
		background: transparent;
	}
</style>
