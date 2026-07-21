<script lang="ts">
	// The Sign sub-step (SIGNING.md §2.1, §2.2) -- slots between review and
	// slide-to-send. Method chooser + orchestration: each method ends at the
	// same POST /sign, and this component just re-renders `progress` from
	// whatever the method returns. Filled in across T1 (file) -> T2 (QR) ->
	// T4/T5 (devices) -> T6 (multisig roster). BROWSER-SIDE component --
	// never imports $lib/server (SIGNING.md §0.3).
	import type { SigningProgress } from '$lib/shared/signing.js';

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
		} catch {
			error = 'could not accept that signature -- check your connection and try again';
		} finally {
			busy = false;
		}
	}
</script>

<section class="sign-step">
	<p class="t-micro">How do you want to sign?</p>
	{#if progress.complete}
		<p class="t-label ready">All signatures collected -- ready to send.</p>
	{:else}
		<p class="t-label hint">
			{progress.required - progress.collected} more signature{progress.required - progress.collected === 1
				? ''
				: 's'} needed.
		</p>
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
	}
</style>
