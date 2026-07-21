<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { page } from '$app/state';

	let { children } = $props();

	const nav = [
		{ href: '/', label: 'Home' },
		{ href: '/wallets', label: 'Wallets' },
		{ href: '/mining', label: 'Mining' },
		{ href: '/explorer', label: 'Explorer' }
	];

	function isActive(href: string): boolean {
		return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Hearth</title>
</svelte:head>

<div class="shell">
	<header class="topnav hairline">
		<a class="brand t-title" href="/">
			<span class="brand-mark" aria-hidden="true"></span>
			Hearth
		</a>

		<nav>
			{#each nav as item (item.href)}
				<a href={item.href} class:active={isActive(item.href)}>{item.label}</a>
			{/each}
		</nav>

		<div class="topnav-actions">
			<span class="badge-no-cloud">No cloud &middot; No telemetry</span>
			<a href="/settings" class:active={isActive('/settings')} class="settings-link" title="Settings"
				>Settings</a
			>
			<ThemeToggle />
		</div>
	</header>

	<main>
		{@render children()}
	</main>
</div>

<style>
	.shell {
		min-height: 100%;
		display: flex;
		flex-direction: column;
	}

	.topnav {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-2) var(--space-4);
		background: var(--bg-deep);
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		text-decoration: none;
		color: var(--text-hero);
		margin-right: var(--space-2);
	}

	.brand-mark {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-dim) inset;
	}

	nav {
		display: flex;
		gap: var(--space-3);
		flex: 1;
	}

	nav a,
	.settings-link {
		text-decoration: none;
		color: var(--text-secondary);
		font-size: var(--t-label);
		font-weight: 500;
		padding: 6px 4px;
		border-bottom: 2px solid transparent;
	}

	nav a:hover,
	.settings-link:hover {
		color: var(--text);
	}

	nav a.active,
	.settings-link.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.topnav-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	main {
		flex: 1;
		padding: var(--space-5) var(--space-4);
		max-width: 1100px;
		width: 100%;
		margin: 0 auto;
	}
</style>
