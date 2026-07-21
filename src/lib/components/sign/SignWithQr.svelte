<script lang="ts">
	// Sign with QR (BBQr animated show + camera scan-back) -- SIGNING.md §2.2.3.
	// Filled in at T2. BROWSER-SIDE component -- never imports $lib/server
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

<p class="t-label muted">QR signing lands in a later step.</p>

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
