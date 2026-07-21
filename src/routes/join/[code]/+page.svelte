<script lang="ts">
	// The captain-identified landing (COME-ABOARD.md §2) -- the flagship
	// screen. Rendered OUTSIDE the (app) shell: no top-nav, no member chrome,
	// the visitor isn't a member yet. Warm host voice, one primary action,
	// theme-aware from first paint (same ThemeToggle as /login).
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const ROLE_COPY: Record<'member' | 'guest', string> = {
		member:
			"You'll come aboard as a Member — your own wallet, your own keys, watched by this node. Nothing ever leaves the box.",
		guest:
			"You'll come aboard as a Guest — a read-only seat by the fire: watch the shared explorer and node health. No wallet, no spending — just the view."
	};
</script>

<svelte:head>
	<title>Come aboard -- Hearth</title>
</svelte:head>

<div class="page">
	<div class="corner"><ThemeToggle /></div>

	<div class="card panel">
		<a class="brand t-title" href="/"><span class="brand-mark" aria-hidden="true"></span> Hearth</a>

		{#if data.state === 'invalid'}
			<p class="t-micro eyebrow">This link is no longer valid</p>
			<p class="t-body">Ask your host for a fresh invitation.</p>
		{:else}
			<p class="t-micro eyebrow">You're invited</p>
			<h1 class="t-title headline">
				You've been invited to navigate Bitcoin with <span class="captain">{data.captain}</span>.
			</h1>
			<p class="t-body role-copy">{ROLE_COPY[data.role]}</p>

			<p class="t-micro grants-label">What you'll be able to do</p>
			<ul class="grants">
				{#each data.grants as grant (grant)}
					<li><span class="tick" aria-hidden="true">✓</span> {grant}</li>
				{/each}
			</ul>

			<div class="hairline divider"></div>
			<p class="t-label form-title">Set your password to come aboard</p>

			<form method="POST">
				{#if form?.error}
					<p class="error" role="alert">{form.error}</p>
				{/if}

				<label class="field">
					<span class="t-label">Username</span>
					<input
						class="t-mono"
						type="text"
						name="username"
						autocomplete="username"
						value={form?.username ?? ''}
						required
					/>
				</label>

				<label class="field">
					<span class="t-label">Password</span>
					<input type="password" name="password" autocomplete="new-password" required minlength="8" />
				</label>

				<label class="field">
					<span class="t-label">Confirm password</span>
					<input type="password" name="confirmPassword" autocomplete="new-password" required minlength="8" />
				</label>

				<label class="field">
					<span class="t-label">Display name <span class="optional">(optional)</span></span>
					<input type="text" name="displayName" value={form?.displayName ?? ''} placeholder={form?.username ?? ''} />
				</label>

				<button class="btn-primary" type="submit">Come aboard</button>
			</form>
		{/if}

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
		text-align: left;
		line-height: 1.3;
	}

	.captain {
		color: var(--text-hero);
	}

	.role-copy {
		text-align: left;
		color: var(--text-secondary);
	}

	.grants-label {
		text-align: left;
		color: var(--text-muted);
		margin-top: var(--space-2);
	}

	.grants {
		list-style: none;
		margin: 0;
		padding: 0;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.grants li {
		font-size: var(--t-body);
		color: var(--text);
	}

	.tick {
		color: var(--sage);
		margin-right: 4px;
	}

	.divider {
		margin: var(--space-3) 0 0;
	}

	.form-title {
		text-align: left;
		color: var(--text-secondary);
		margin: var(--space-2) 0 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		text-align: left;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.optional {
		color: var(--text-muted);
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
	}

	.field input {
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 10px 12px;
		color: var(--text);
		font-size: var(--t-body);
	}

	.field input:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.error {
		color: var(--error);
		font-size: var(--t-label);
		margin: 0;
	}

	.btn-primary {
		width: 100%;
		margin-top: var(--space-1);
		padding: 12px 20px;
	}

	.badge-no-cloud {
		align-self: center;
		margin-top: var(--space-3);
	}
</style>
