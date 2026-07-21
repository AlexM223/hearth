<script lang="ts">
	// Wallets: the ONE unified engine list + import (DECISIONS.md §4.2). Single-
	// sig and multisig are one code path -- "kind" is just a badge here.
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let showImport = $state(false);
	let name = $state('');
	let payload = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	function fmtSats(sats: number): string {
		return sats.toLocaleString('en-US');
	}

	function kindLabel(kind: string, threshold: number, keyCount: number): string {
		return kind === 'multisig' ? `${threshold}-of-${keyCount} multisig` : 'single-sig';
	}

	async function submitImport(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = null;
		busy = true;
		try {
			const trimmed = payload.trim();
			const body: Record<string, unknown> = { name: name.trim() };
			// A descriptor contains "(" ; a bare extended key does not.
			if (trimmed.includes('(')) body.descriptor = trimmed;
			else body.xpub = trimmed;

			const res = await fetch('/api/wallets', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({ message: 'import failed' }));
				errorMsg = j.message ?? 'import failed';
				return;
			}
			const created = await res.json();
			showImport = false;
			name = '';
			payload = '';
			await invalidateAll();
			await goto(`/wallets/${created.id}`);
		} catch {
			errorMsg = 'import failed -- check the descriptor or xpub';
		} finally {
			busy = false;
		}
	}
</script>

<section class="head">
	<div>
		<p class="t-micro">Wallets</p>
		<h1 class="t-title">Your wallets</h1>
	</div>
	<button class="btn-primary" type="button" onclick={() => (showImport = !showImport)}>
		{showImport ? 'Cancel' : 'Import wallet'}
	</button>
</section>

{#if showImport}
	<section class="panel import">
		<p class="t-micro">Import watch-only</p>
		<form onsubmit={submitImport}>
			<label class="field">
				<span class="t-label">Name</span>
				<input class="input" bind:value={name} placeholder="Spending" required />
			</label>
			<label class="field">
				<span class="t-label">Descriptor or extended public key</span>
				<textarea
					class="input mono"
					bind:value={payload}
					rows="3"
					placeholder="wsh(sortedmulti(2,[...]xpub.../0/*,...))  or  zpub6r..."
					required
				></textarea>
			</label>
			<p class="hint t-label">
				Single-sig and multisig import the same way -- paste an xpub/ypub/zpub or a full output
				descriptor. Keys stay yours; this node only watches.
			</p>
			{#if errorMsg}<p class="err t-label">{errorMsg}</p>{/if}
			<button class="btn-primary" type="submit" disabled={busy}>
				{busy ? 'Importing…' : 'Import'}
			</button>
		</form>
	</section>
{/if}

{#if data.wallets.length === 0}
	<section class="panel empty">
		<h2 class="t-title">No wallets yet</h2>
		<p class="t-label">
			Import a watch-only single-sig or multisig wallet to see balances, history and send/receive
			here. One engine, one broadcast path.
		</p>
	</section>
{:else}
	<ul class="wallet-list">
		{#each data.wallets as w (w.id)}
			<li class="panel wallet-card">
				<a href={`/wallets/${w.id}`}>
					<div class="wallet-top">
						<span class="t-title">{w.name}</span>
						<span class="badge t-label">{kindLabel(w.kind, w.threshold, w.keyCount)}</span>
					</div>
					<p class="balance">
						{fmtSats(w.confirmedSats)} <span class="unit">sats</span>
					</p>
					{#if w.unconfirmedSats > 0}
						<p class="pending t-label">+{fmtSats(w.unconfirmedSats)} pending</p>
					{/if}
					<p class="meta t-label">{w.scriptType} · {w.network}</p>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: var(--space-4);
	}
	.import {
		margin-bottom: var(--space-4);
	}
	.field {
		display: block;
		margin-bottom: var(--space-3);
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
	.input.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 13px;
		resize: vertical;
	}
	.hint {
		color: var(--text-muted);
	}
	.err {
		color: var(--error);
	}
	.wallet-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space-3);
	}
	.wallet-card a {
		display: block;
		text-decoration: none;
		color: inherit;
	}
	.wallet-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
	}
	.badge {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 2px 10px;
		color: var(--text-secondary);
		white-space: nowrap;
	}
	.balance {
		font-family: var(--font-serif);
		font-size: 28px;
		color: var(--text-hero);
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
		margin: var(--space-2) 0 0;
	}
	.balance .unit {
		font-size: 0.5em;
		color: var(--text-secondary);
	}
	.pending {
		color: var(--sage);
		margin: 2px 0 0;
	}
	.meta {
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
	}
</style>
