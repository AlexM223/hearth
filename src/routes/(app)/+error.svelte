<script lang="ts">
	// Branded in-app error boundary (UX sweep hearth-2hi, finding #1). Rendered
	// INSIDE the (app) layout, so the top nav/header stays put -- only the main
	// content is replaced. Tone matches the invalid-invite page (/join/[code]),
	// the one place in the app that already had an on-brand empty state before
	// this fix: warm, plain-language, never fear-based (DECISIONS.md §1).
	import { page } from '$app/state';

	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? '');

	type Copy = { eyebrow: string; title: string; body: string };

	const copy = $derived.by((): Copy => {
		if (status === 404) {
			return {
				eyebrow: "Can't find that",
				title: "This one isn't here.",
				body:
					message && message !== 'Not Found'
						? message
						: "That page or wallet doesn't exist -- check the address, or head back home."
			};
		}
		if (status === 403) {
			return {
				eyebrow: 'Not your seat by the fire',
				title: "You don't have access to that.",
				body: 'Ask your host (the Owner) if you think this is a mistake.'
			};
		}
		if (status >= 500) {
			return {
				eyebrow: "Something's not right",
				title: "That didn't work.",
				body: 'Hearth hit a snag loading this page. Your node and wallets are untouched -- try again in a moment.'
			};
		}
		return {
			eyebrow: `Error ${status}`,
			title: 'Something went sideways.',
			body: message || 'Try again, or head back home.'
		};
	});
</script>

<svelte:head>
	<title>{copy.title} -- Hearth</title>
</svelte:head>

<section class="panel empty-state">
	<p class="t-micro eyebrow">{copy.eyebrow}</p>
	<h1 class="t-title">{copy.title}</h1>
	<p class="t-body body">{copy.body}</p>
	<div class="actions">
		<a class="btn-primary" href="/">Back home</a>
		{#if status >= 500}
			<button class="btn-primary secondary" type="button" onclick={() => location.reload()}>Try again</button>
		{/if}
	</div>
</section>

<style>
	.empty-state {
		max-width: 480px;
		margin: var(--space-5) auto;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
	}
	.eyebrow {
		color: var(--text-muted);
	}
	.body {
		color: var(--text-secondary);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.actions a,
	.actions button {
		text-decoration: none;
	}
	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}
</style>
