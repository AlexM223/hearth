<script lang="ts">
	// Root-level branded error boundary (UX sweep hearth-2hi, finding #1).
	// Catches everything the (app) group's own +error.svelte can't: a truly
	// unmatched route (no layout group applies at all) and any error thrown
	// before/outside the (app) layout's own load. Standalone page -- no app
	// shell to keep, so it borrows the /join/[code] tone template directly
	// (brand mark, ThemeToggle, centered card, warm host voice).
	import { page } from '$app/state';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

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
						: "That page doesn't exist -- check the address, or head back home."
			};
		}
		if (status === 403) {
			return {
				eyebrow: 'Not your seat by the fire',
				title: "You don't have access to that.",
				body: 'Ask your host if you think this is a mistake.'
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

<div class="page">
	<div class="corner"><ThemeToggle /></div>

	<div class="card panel">
		<a class="brand t-title" href="/"><span class="brand-mark" aria-hidden="true"></span> Hearth</a>

		<p class="t-micro eyebrow">{copy.eyebrow}</p>
		<h1 class="t-title headline">{copy.title}</h1>
		<p class="t-body body">{copy.body}</p>

		<div class="actions">
			<a class="btn-primary" href="/">Back home</a>
			{#if status >= 500}
				<button class="btn-primary secondary" type="button" onclick={() => location.reload()}>Try again</button>
			{/if}
		</div>

		<span class="badge-no-cloud">No cloud &middot; No telemetry &middot; Nothing leaves this box.</span>
	</div>
</div>

<style>
	.page {
		min-height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
	}
	.corner {
		position: fixed;
		top: var(--space-2);
		right: var(--space-3);
	}
	.card {
		width: 100%;
		max-width: 460px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		text-align: center;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		text-decoration: none;
		color: var(--text);
		margin-bottom: var(--space-2);
	}
	.brand-mark {
		width: 10px;
		height: 10px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		display: inline-block;
	}
	.eyebrow {
		color: var(--text-muted);
	}
	.headline {
		line-height: 1.3;
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
	.badge-no-cloud {
		align-self: center;
		margin-top: var(--space-3);
	}
</style>
