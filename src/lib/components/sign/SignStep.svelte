<script lang="ts">
	// The Sign sub-step (SIGNING.md §2.1, §2.2) -- slots between review and
	// slide-to-send. A row of calm method tiles; every method ends at the
	// same POST /sign, and this component just re-renders `progress` from
	// whatever the method returns. BROWSER-SIDE component -- never imports
	// $lib/server (SIGNING.md §0.3).
	import type { SigningProgress } from '$lib/shared/signing.js';
	import SignWithFile from './SignWithFile.svelte';
	import SignWithQr from './SignWithQr.svelte';
	import SignWithDevice from './SignWithDevice.svelte';

	type Method = 'file' | 'qr' | 'device';

	let {
		walletId,
		draftId,
		psbt,
		progress = $bindable(),
		httpsExternalPort
	}: {
		walletId: number;
		draftId: number;
		psbt: string;
		progress: SigningProgress;
		httpsExternalPort: number | null;
	} = $props();

	let method = $state<Method | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submitSignedPsbt(signedPsbt: string) {
		error = null;
		busy = true;
		try {
			const res = await fetch(`/api/wallets/${walletId}/drafts/${draftId}/sign`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ psbt: signedPsbt })
			});
			const j = await res.json().catch(() => ({ message: 'could not accept that signature' }));
			if (!res.ok) {
				error = j.message ?? 'could not accept that signature';
				return;
			}
			progress = j.progress;
			method = null; // back to the tiles -- multisig may need another signer/method
		} catch {
			error = 'could not accept that signature -- check your connection and try again';
		} finally {
			busy = false;
		}
	}

	function onerror(message: string) {
		error = message;
	}
</script>

<section class="sign-step">
	<p class="t-micro">How do you want to sign?</p>
	{#if progress.complete}
		<p class="t-label ready">All signatures collected -- ready to send.</p>
	{:else}
		<p class="t-label hint">
			Add {progress.required - progress.collected} more signature{progress.required - progress.collected === 1
				? ''
				: 's'} to send.
		</p>
	{/if}

	{#if !method}
		<div class="tiles">
			<button class="tile" type="button" onclick={() => (method = 'device')} disabled={busy}>
				<span class="t-label">Sign with device</span>
				<span class="t-label muted">Ledger, Trezor</span>
			</button>
			<button class="tile" type="button" onclick={() => (method = 'file')} disabled={busy}>
				<span class="t-label">Sign with file</span>
				<span class="t-label muted">Download, sign, upload</span>
			</button>
			<button class="tile" type="button" onclick={() => (method = 'qr')} disabled={busy}>
				<span class="t-label">Sign with QR</span>
				<span class="t-label muted">Show and scan</span>
			</button>
		</div>
	{:else}
		<button class="link-btn t-label" type="button" onclick={() => (method = null)}>&larr; choose a different way</button>
		<div class="method-panel">
			{#if method === 'file'}
				<SignWithFile {walletId} {draftId} {psbt} onsigned={submitSignedPsbt} {onerror} />
			{:else if method === 'qr'}
				<SignWithQr {psbt} onsigned={submitSignedPsbt} {onerror} {httpsExternalPort} />
			{:else}
				<SignWithDevice {psbt} onsigned={submitSignedPsbt} {onerror} {httpsExternalPort} />
			{/if}
		</div>
	{/if}

	{#if error}<p class="err t-label">{error}</p>{/if}
</section>

<style>
	.sign-step {
		margin: var(--space-3) 0;
	}
	.ready {
		color: var(--sage);
	}
	.hint {
		color: var(--attention, var(--warning));
	}
	.err {
		color: var(--error);
		margin-top: var(--space-2);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: flex-start;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		padding: 12px;
		cursor: pointer;
		color: var(--text);
		font-family: var(--font-ui);
	}
	.tile:hover {
		border-color: var(--accent-dim);
	}
	.muted {
		color: var(--text-muted);
	}
	.link-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 0;
		font-family: var(--font-ui);
		margin-top: var(--space-2);
	}
	.method-panel {
		margin-top: var(--space-2);
	}
</style>
