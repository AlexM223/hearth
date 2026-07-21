<script lang="ts">
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Set your credentials -- Hearth</title>
</svelte:head>

<div class="page">
	<div class="corner"><ThemeToggle /></div>

	<div class="card panel">
		<p class="t-micro">First run</p>
		<h1 class="t-title">Make this hearth yours</h1>
		<p class="t-label">
			You signed in with the install password -- it stays visible on your platform's setup screen.
			Choose your own username and password to finish setting up.
		</p>

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
					value={form?.username ?? data.username}
					required
				/>
			</label>

			<label class="field">
				<span class="t-label">New password</span>
				<input type="password" name="password" autocomplete="new-password" required minlength="8" />
			</label>

			<label class="field">
				<span class="t-label">Confirm password</span>
				<input
					type="password"
					name="confirmPassword"
					autocomplete="new-password"
					required
					minlength="8"
				/>
			</label>

			<button class="btn-primary" type="submit">Finish setup</button>
		</form>
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
		max-width: 400px;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		text-align: center;
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
</style>
