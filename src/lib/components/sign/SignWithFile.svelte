<script lang="ts">
	// Sign with file (download unsigned / upload signed) -- SIGNING.md §2.2.2.
	// Filled in at T1. BROWSER-SIDE component -- never imports $lib/server
	// (SIGNING.md §0.3).
	let {
		psbt,
		onsigned,
		onerror
	}: {
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
	} = $props();
</script>

<p class="t-label muted">File signing lands in a later step.</p>

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
