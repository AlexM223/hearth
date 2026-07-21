<script lang="ts">
	// Sign with device (Ledger WebHID / Trezor popup) -- SIGNING.md §2.2.1.
	// Filled in across T4 (Ledger) and T5 (Trezor). BROWSER-SIDE component --
	// never imports $lib/server (SIGNING.md §0.3).
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

<p class="t-label muted">Device signing lands in a later step.</p>

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
