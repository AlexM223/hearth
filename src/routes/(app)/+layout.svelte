<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const nav = [
		{ href: '/', label: 'Home' },
		{ href: '/wallets', label: 'Wallets' },
		{ href: '/mining', label: 'Mining' },
		{ href: '/explorer', label: 'Explorer' }
	];

	function isActive(href: string): boolean {
		return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
	}

	// Global search (EXPLORER.md §3.6, the 2-clicks law): one search input in
	// the top nav, reachable from every authenticated page -- the shared
	// instrument's ONE search surface (never duplicated per-page).
	let searchQuery = $state('');
	let searchBusy = $state(false);
	let searchNotice = $state<string | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | null = null;

	function flashNotice(message: string) {
		searchNotice = message;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (searchNotice = null), 4000);
	}

	async function runSearch() {
		const q = searchQuery.trim();
		if (!q || searchBusy) return;
		searchBusy = true;
		try {
			const res = await fetch(`/api/chain/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) {
				flashNotice('Search failed -- try again.');
				return;
			}
			const result = (await res.json()) as { type: 'block' | 'tx' | 'address' | 'unknown'; value: string };
			if (result.type === 'unknown') {
				flashNotice('Nothing matches that search — check for typos');
				return;
			}
			searchQuery = '';
			await goto(`/explorer/${result.type}/${encodeURIComponent(result.value)}`);
		} catch {
			flashNotice('Search failed -- try again.');
		} finally {
			searchBusy = false;
		}
	}
</script>

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

		<form class="search" onsubmit={(e) => (e.preventDefault(), runSearch())}>
			<input
				class="search-input t-mono"
				type="search"
				placeholder="Search a block, transaction, or address"
				bind:value={searchQuery}
				aria-label="Search a block, transaction, or address"
			/>
			<button class="search-btn" type="submit" disabled={searchBusy} aria-label="Search">🔍</button>
		</form>
		{#if searchNotice}
			<p class="search-notice t-label" role="status">{searchNotice}</p>
		{/if}

		<div class="topnav-actions">
			<span class="badge-no-cloud">No cloud &middot; No telemetry</span>
			{#if data.user?.role === 'owner'}
				<a href="/settings" class:active={isActive('/settings')} class="settings-link" title="Settings"
					>Settings</a
				>
			{:else if data.user}
				<a href="/me" class:active={isActive('/me')} class="settings-link" title="My profile">My profile</a>
			{/if}
			{#if data.user}
				<span class="username t-label">{data.user.username}</span>
				<form method="POST" action="/logout">
					<button class="logout-btn" type="submit">Sign out</button>
				</form>
			{/if}
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
		position: relative;
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

	.search {
		display: flex;
		align-items: center;
		gap: 4px;
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 4px 4px 4px 12px;
	}

	.search-input {
		background: none;
		border: none;
		color: var(--text);
		font-size: var(--t-label);
		width: 220px;
		outline: none;
	}

	.search-input::placeholder {
		color: var(--text-muted);
	}

	.search-btn {
		background: none;
		border: none;
		border-radius: var(--radius-pill);
		padding: 4px 10px;
		cursor: pointer;
		color: var(--text-secondary);
	}

	.search-btn:hover {
		color: var(--text);
	}

	.search-notice {
		position: absolute;
		top: 56px;
		right: var(--space-4);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		padding: 8px 14px;
		color: var(--text-secondary);
		z-index: 10;
	}

	.topnav-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.username {
		color: var(--text-secondary);
	}

	.logout-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: var(--t-label);
		font-weight: 500;
		cursor: pointer;
		padding: 6px 4px;
	}

	.logout-btn:hover {
		color: var(--text);
	}

	main {
		flex: 1;
		padding: var(--space-5) var(--space-4);
		max-width: 1100px;
		width: 100%;
		margin: 0 auto;
	}
</style>
