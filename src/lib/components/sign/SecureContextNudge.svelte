<script lang="ts">
	// The calm HTTPS-hop explainer (SIGNING.md §4.3). Filled in at T3.
	// BROWSER-SIDE component -- never imports $lib/server (SIGNING.md §0.3).
	let {
		what,
		httpsExternalPort
	}: {
		what: string;
		httpsExternalPort: number | null;
	} = $props();
</script>

{#if httpsExternalPort}
	<p class="t-label muted">{what} needs a secure connection. This lands in a later step.</p>
{/if}

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
