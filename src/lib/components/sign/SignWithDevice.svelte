<script lang="ts">
	// Sign with device (Ledger WebHID / Trezor popup) -- SIGNING.md §2.2.1.
	// Per-device secure-context routing lands here at T3; the actual signing
	// flows land at T4 (Ledger) and T5 (Trezor). BROWSER-SIDE component --
	// never imports $lib/server (SIGNING.md §0.3).
	import { needsSecureContext, secureOrigin } from '$lib/hw/secureContext.js';
	import SecureContextNudge from './SecureContextNudge.svelte';

	let {
		psbt,
		onsigned,
		onerror,
		httpsExternalPort
	}: {
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
		httpsExternalPort: number | null;
	} = $props();

	type DeviceTile = 'ledger' | 'trezor';
	let device = $state<DeviceTile | null>(null);

	// Trezor's popup holds its own secure-context transport (works on plain
	// HTTP); Ledger's WebHID needs the page itself to be a secure context.
	const ledgerNeedsHop = $derived(needsSecureContext('ledger') && !secureOrigin());
</script>

{#if !device}
	<div class="device-tiles">
		<button class="device-tile t-label" type="button" onclick={() => (device = 'ledger')}>Ledger</button>
		<button class="device-tile t-label" type="button" onclick={() => (device = 'trezor')}>Trezor</button>
	</div>
{:else if device === 'ledger' && ledgerNeedsHop}
	<SecureContextNudge what="Ledger" {httpsExternalPort} />
{:else}
	<p class="t-label muted">
		{device === 'ledger' ? 'Ledger' : 'Trezor'} signing lands in a later step.
	</p>
{/if}

<style>
	.device-tiles {
		display: flex;
		gap: var(--space-2);
	}
	.device-tile {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		padding: 10px 16px;
		cursor: pointer;
		color: var(--text);
		font-family: var(--font-ui);
	}
	.muted {
		color: var(--text-muted);
	}
</style>
