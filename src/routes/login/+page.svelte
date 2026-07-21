<script lang="ts">
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>Sign in -- Hearth</title>
</svelte:head>

<div class="page">
	<div class="corner"><ThemeToggle /></div>

	<div class="card panel">
		<p class="t-micro">The hearth</p>
		<h1 class="t-title">Come aboard</h1>
		<p class="tagline t-label">Come navigate Bitcoin with me.</p>

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
				<input type="password" name="password" autocomplete="current-password" required />
			</label>

			<button class="btn-primary" type="submit">Sign in</button>
		</form>

		<span class="badge-no-cloud">No cloud &middot; No telemetry</span>
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
		max-width: 360px;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		text-align: center;
	}

	.tagline {
		margin: 0 0 var(--space-2);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		text-align: left;
		margin-top: var(--space-2);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
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
