<script lang="ts">
	// The calm HTTPS-hop explainer (SIGNING.md §4.3). Rendered instead of an
	// error when a secure-context-only method (Ledger, camera scan) is chosen
	// on a plain-HTTP origin. The URL is built from the CURRENT host + the
	// server-advertised httpsExternalPort -- never a literal 4489 -- so the
	// user lands on the same draft/review screen on the secure origin.
	// BROWSER-SIDE component -- never imports $lib/server (SIGNING.md §0.3).
	import { secureHopUrl } from '$lib/hw/secureContext.js';

	let {
		what,
		httpsExternalPort
	}: {
		what: string;
		httpsExternalPort: number | null;
	} = $props();

	const hopUrl = $derived(
		httpsExternalPort && typeof window !== 'undefined'
			? secureHopUrl(
					{ hostname: window.location.hostname, pathname: window.location.pathname, search: window.location.search },
					httpsExternalPort
				)
			: null
	);
</script>

{#if hopUrl}
	<div class="nudge panel">
		<p class="t-label">{what} connects over a secure browser channel.</p>
		<p class="t-label muted">Open Hearth on its secure address to continue -- your browser will ask you to
			accept its certificate the first time.</p>
		<a class="btn-primary secondary" href={hopUrl}>Continue on the secure connection &rarr;</a>
	</div>
{:else}
	<p class="t-label muted">{what} needs a secure connection, and none is set up for this box yet.</p>
{/if}

<style>
	.nudge {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		align-items: flex-start;
		padding: var(--space-3);
	}
	.muted {
		color: var(--text-muted);
	}
</style>
