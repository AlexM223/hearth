<script lang="ts">
	// Self profile & prefs (COME-ABOARD.md §3.2's carve-out): where a Member/
	// Guest changes their own password since Settings is Owner-only.
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { readStoredTheme, applyThemeLocally, type ThemeChoice } from '$lib/theme.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Reconciled with the header ThemeToggle (UX sweep hearth-i2x): this used
	// to read ONLY the server-persisted `prefs.theme` row, which the header
	// toggle never wrote to -- so this could show "System" selected while the
	// page itself was actually rendering Dark. `liveTheme` starts from the
	// server value (SSR-safe) then, on mount, is overridden by the SAME live
	// source the header toggle writes to (localStorage) -- the sweep's own
	// suggested fix.
	// svelte-ignore state_referenced_locally -- SSR-safe seed, overridden by
	// the live localStorage value in onMount below.
	let liveTheme = $state<ThemeChoice>(data.prefs.theme);
	onMount(() => {
		liveTheme = readStoredTheme();
	});
</script>

<svelte:head>
	<title>My profile -- Hearth</title>
</svelte:head>

<section class="panel">
	<p class="t-micro">Your account</p>
	<h1 class="t-title">Profile &amp; password</h1>

	{#if form?.saved}<p class="t-label ok">Saved.</p>{/if}
	{#if form?.error}<p class="t-label err">{form.error}</p>{/if}

	<form method="POST" action="?/updateProfile">
		<label class="field">
			<span class="t-label">Display name</span>
			<input class="input" type="text" name="displayName" placeholder="How you'd like to be greeted" />
		</label>

		<div class="hairline divider"></div>
		<p class="t-label section-title">Change password (optional)</p>

		<label class="field">
			<span class="t-label">Current password</span>
			<input class="input" type="password" name="currentPassword" autocomplete="current-password" />
		</label>
		<label class="field">
			<span class="t-label">New password</span>
			<input class="input" type="password" name="newPassword" autocomplete="new-password" minlength="8" />
		</label>
		<label class="field">
			<span class="t-label">Confirm new password</span>
			<input class="input" type="password" name="confirmPassword" autocomplete="new-password" minlength="8" />
		</label>

		<button class="btn-primary" type="submit">Save changes</button>
	</form>
</section>

<section class="panel theme-panel">
	<p class="t-micro">Display</p>
	<form
		method="POST"
		action="?/setTheme"
		use:enhance={() => {
			// Apply to THIS device immediately (localStorage + data-theme) --
			// the same effect the header ThemeToggle has -- rather than waiting
			// on the round trip; the server action below still persists it too.
			applyThemeLocally(liveTheme);
			return async ({ update }) => update();
		}}
	>
		<fieldset class="theme-choice">
			<label class="radio">
				<input type="radio" name="theme" value="system" bind:group={liveTheme} />
				<span class="t-label">System</span>
			</label>
			<label class="radio">
				<input type="radio" name="theme" value="dark" bind:group={liveTheme} />
				<span class="t-label">Dark</span>
			</label>
			<label class="radio">
				<input type="radio" name="theme" value="light" bind:group={liveTheme} />
				<span class="t-label">Light</span>
			</label>
		</fieldset>
		<button class="btn-primary secondary" type="submit">Save preference</button>
	</form>
</section>

<section class="panel entry">
	<p class="t-micro">Notifications</p>
	<p class="t-label">
		Choose which channels reach you -- email, Telegram, ntfy, Nostr, webhook -- and which of your
		own events fire on each.
	</p>
	<a class="btn-primary secondary" href="/me/notifications">Manage notifications</a>
</section>

<style>
	.field {
		display: block;
		margin: var(--space-2) 0;
	}
	.field span {
		display: block;
		color: var(--text-secondary);
		margin-bottom: 6px;
	}
	.input {
		width: 100%;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		color: var(--text);
		font-family: var(--font-ui);
		padding: 10px 12px;
		font-size: var(--t-body);
	}
	.divider {
		margin: var(--space-3) 0;
	}
	.section-title {
		color: var(--text-secondary);
		margin-bottom: var(--space-2);
	}
	.ok {
		color: var(--sage);
	}
	.err {
		color: var(--error);
	}
	.theme-panel,
	.entry {
		margin-top: var(--space-3);
	}
	.entry a {
		display: inline-block;
		margin-top: var(--space-2);
		text-decoration: none;
	}
	.theme-choice {
		border: none;
		padding: 0;
		display: flex;
		gap: var(--space-3);
		margin-bottom: var(--space-2);
	}
	.radio {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}
</style>
