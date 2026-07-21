<script lang="ts">
	// M-of-N cosigner roster (SIGNING.md §2.3): one row per cosigner with a
	// Signed/Waiting chip, collapsing to "Ready to send" once the quorum is
	// met. Any Hearth member's own signature can arrive by any method (device,
	// file, QR) or -- once M3 lands -- from another member's own visit; the
	// roster just re-renders whatever `progress` says. BROWSER-SIDE component
	// -- never imports $lib/server (SIGNING.md §0.3).
	import type { SigningProgress } from '$lib/shared/signing.js';

	let {
		progress,
		cosignerNames = {}
	}: {
		progress: SigningProgress;
		cosignerNames?: Record<string, string>;
	} = $props();
</script>

<div class="roster">
	{#if progress.complete}
		<p class="t-label ready">Ready to send.</p>
	{:else}
		<p class="t-label header">{progress.collected} of {progress.required} signatures collected</p>
		<ul>
			{#each progress.keys as key (key.fingerprint + key.path)}
				<li class="hairline row">
					<span class="name t-label">{cosignerNames[key.fingerprint] ?? key.fingerprint}</span>
					<span class="chip t-label" class:signed={key.signed}>{key.signed ? 'Signed' : 'Waiting'}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.roster {
		margin: var(--space-2) 0;
	}
	.ready {
		color: var(--sage);
	}
	.header {
		color: var(--text-secondary);
		margin-bottom: var(--space-2);
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		padding: 8px 0;
	}
	.name {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.chip {
		color: var(--attention, var(--warning));
	}
	.chip.signed {
		color: var(--sage);
	}
</style>
