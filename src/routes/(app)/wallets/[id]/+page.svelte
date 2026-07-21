<script lang="ts">
	// Wallet detail: sats-first hero, Receive rotation, and the send flow
	// build -> review -> slide-to-send -> broadcast (DECISIONS.md §3 friction
	// ladder). Coin control lives behind an Advanced toggle. One engine, one
	// broadcast path -- this screen never knows single vs multisig except as a badge.
	import { invalidateAll } from '$app/navigation';
	import { formatSats as fmtSats } from '$lib/format.js';
	import SignStep from '$lib/components/sign/SignStep.svelte';
	import type { SigningProgress } from '$lib/shared/signing.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Tab = 'history' | 'receive' | 'send';
	let tab = $state<Tab>('history');

	// Seeded from the loader, then rotated client-side on demand (Receive tab).
	// svelte-ignore state_referenced_locally
	let receiveAddress = $state(data.receiveAddress);

	async function rotateReceive() {
		const res = await fetch(`/api/wallets/${data.wallet.id}/receive`, { method: 'POST' });
		if (res.ok) receiveAddress = (await res.json()).address;
	}

	// ---- send flow state
	let toAddress = $state('');
	let amount = $state('');
	let feeRate = $state('5');
	let advanced = $state(false);
	let selectedUtxos = $state<Record<string, boolean>>({});
	let review = $state<null | {
		draftId: number;
		psbt: string;
		recipients: { address: string; amountSats: number }[];
		changeAmountSats: number | null;
		feeSats: number;
		vsize: number;
		totalInputSats: number;
		progress: SigningProgress;
	}>(null);
	let sendBusy = $state(false);
	let sendError = $state<string | null>(null);
	let broadcastTxid = $state<string | null>(null);
	let slide = $state(0); // 0..100 slide-to-send progress

	function outpoint(u: { txid: string; vout: number }): string {
		return `${u.txid}:${u.vout}`;
	}

	async function buildDraft() {
		sendError = null;
		review = null;
		broadcastTxid = null;
		slide = 0;
		sendBusy = true;
		try {
			const onlyUtxos = advanced
				? data.utxos.filter((u) => selectedUtxos[outpoint(u)]).map((u) => ({ txid: u.txid, vout: u.vout }))
				: undefined;
			const body: Record<string, unknown> = {
				recipients: [{ address: toAddress.trim(), amountSats: Number(amount) }],
				feeRate: Number(feeRate)
			};
			if (onlyUtxos && onlyUtxos.length) body.onlyUtxos = onlyUtxos;

			const res = await fetch(`/api/wallets/${data.wallet.id}/drafts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const j = await res.json().catch(() => ({ message: 'build failed' }));
			if (!res.ok) {
				sendError = j.message ?? 'could not build the transaction';
				return;
			}
			review = { draftId: j.draftId, psbt: j.psbt, ...j.review };
		} catch {
			sendError = 'could not build the transaction';
		} finally {
			sendBusy = false;
		}
	}

	async function confirmSend() {
		if (!review || slide < 100 || !review.progress.complete) return;
		sendBusy = true;
		sendError = null;
		try {
			// The signing surface (Sign step, above) already merged enough
			// signatures into the draft server-side before the slider ever
			// enables -- this call rides the already-signed draft to the one
			// broadcast path.
			const res = await fetch(`/api/wallets/${data.wallet.id}/drafts/${review.draftId}/broadcast`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const j = await res.json().catch(() => ({ message: 'broadcast failed' }));
			if (!res.ok) {
				sendError = j.message ?? 'broadcast failed';
				slide = 0;
				return;
			}
			broadcastTxid = j.txid;
			review = null;
			toAddress = '';
			amount = '';
			await invalidateAll();
		} catch {
			sendError = 'broadcast failed';
			slide = 0;
		} finally {
			sendBusy = false;
		}
	}

	async function abandonDraft() {
		if (!review) return;
		await fetch(`/api/wallets/${data.wallet.id}/drafts/${review.draftId}/abandon`, { method: 'POST' });
		review = null;
		slide = 0;
	}
</script>

<section class="hero panel">
	<a class="back t-label" href="/wallets">← Wallets</a>
	<p class="t-micro">{data.wallet.name}</p>
	<p class="t-hero">{fmtSats(data.balance.confirmedSats)} <span class="unit">sats</span></p>
	{#if data.balance.unconfirmedSats > 0}
		<p class="pending t-label">+{fmtSats(data.balance.unconfirmedSats)} pending</p>
	{/if}
	<p class="meta t-label">
		{data.wallet.kind === 'multisig'
			? `${data.wallet.threshold}-of-${data.wallet.keyCount} multisig`
			: 'single-sig'} · {data.wallet.scriptType} · {data.wallet.network}
	</p>
	{#if data.snapshot?.truncated}
		<p class="warn t-label">Scan hit the address cap -- some coins past the gap may not be shown.</p>
	{/if}
</section>

<nav class="tabs">
	<button class:active={tab === 'history'} onclick={() => (tab = 'history')}>History</button>
	<button class:active={tab === 'receive'} onclick={() => (tab = 'receive')}>Receive</button>
	<button class:active={tab === 'send'} onclick={() => (tab = 'send')}>Send</button>
</nav>

{#if tab === 'history'}
	<section class="panel">
		{#if data.history.length === 0}
			<p class="t-label empty">No transactions yet.</p>
		{:else}
			<ul class="tx-list">
				{#each data.history as tx (tx.txid)}
					<li class="hairline tx">
						<span class="amt" class:recv={tx.deltaSats > 0}>
							{tx.deltaSats > 0 ? '+' : ''}{fmtSats(tx.deltaSats)}
						</span>
						<span class="txid t-label">{tx.txid.slice(0, 12)}…</span>
						<span class="conf t-label">{tx.height > 0 ? `block ${fmtSats(tx.height)}` : 'unconfirmed'}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{:else if tab === 'receive'}
	<section class="panel receive">
		<p class="t-micro">Receive address</p>
		<p class="addr mono">{receiveAddress ?? '—'}</p>
		<button class="btn-primary secondary" type="button" onclick={rotateReceive}>New address</button>
	</section>
{:else}
	<section class="panel send">
		{#if broadcastTxid}
			<p class="t-micro">Sent</p>
			<p class="t-label ok">Broadcast · {broadcastTxid.slice(0, 20)}…</p>
			<button class="btn-primary secondary" onclick={() => (broadcastTxid = null)}>Done</button>
		{:else if !review}
			<p class="t-micro">Send bitcoin</p>
			<label class="field">
				<span class="t-label">To address</span>
				<input class="input mono" bind:value={toAddress} placeholder="bc1…" />
			</label>
			<label class="field">
				<span class="t-label">Amount (sats)</span>
				<input class="input" bind:value={amount} inputmode="numeric" placeholder="100000" />
			</label>
			<label class="field">
				<span class="t-label">Fee rate (sat/vB)</span>
				<input class="input" bind:value={feeRate} inputmode="decimal" />
			</label>

			<button class="adv-toggle t-label" type="button" onclick={() => (advanced = !advanced)}>
				{advanced ? '− Hide' : '+ Advanced'} coin control
			</button>
			{#if advanced}
				<div class="coin-control">
					<p class="t-label muted">Choose exactly which coins to spend:</p>
					{#each data.utxos as u (outpoint(u))}
						<label class="coin">
							<input type="checkbox" bind:checked={selectedUtxos[outpoint(u)]} />
							<span class="mono">{u.txid.slice(0, 10)}…:{u.vout}</span>
							<span class="coin-val">{fmtSats(u.valueSats)} sats</span>
							<span class="t-label muted">{u.height > 0 ? '' : 'unconfirmed'}</span>
						</label>
					{/each}
					{#if data.utxos.length === 0}<p class="t-label muted">No spendable coins.</p>{/if}
				</div>
			{/if}

			{#if sendError}<p class="err t-label">{sendError}</p>{/if}
			<button class="btn-primary" type="button" onclick={buildDraft} disabled={sendBusy}>
				{sendBusy ? 'Building…' : 'Review'}
			</button>
		{:else}
			<p class="t-micro">Review &amp; send</p>
			<div class="review">
				{#each review.recipients as r (r.address)}
					<div class="review-row">
						<span class="t-label muted">To</span>
						<span class="mono">{r.address}</span>
					</div>
					<div class="review-row">
						<span class="t-label muted">Amount</span>
						<span class="review-amt">{fmtSats(r.amountSats)} sats</span>
					</div>
				{/each}
				<div class="review-row">
					<span class="t-label muted">Network fee</span>
					<span>{fmtSats(review.feeSats)} sats · {review.vsize} vB</span>
				</div>
				{#if review.changeAmountSats !== null}
					<div class="review-row">
						<span class="t-label muted">Change back to you</span>
						<span>{fmtSats(review.changeAmountSats)} sats</span>
					</div>
				{/if}
			</div>

			{#if sendError}<p class="err t-label">{sendError}</p>{/if}

			<SignStep
				walletId={data.wallet.id}
				draftId={review.draftId}
				psbt={review.psbt}
				bind:progress={review.progress}
				httpsExternalPort={data.httpsExternalPort}
				wallet={{
					kind: data.wallet.kind,
					scriptType: data.wallet.scriptType,
					threshold: data.wallet.threshold,
					keys: data.wallet.keys
				}}
			/>

			<p class="t-label muted slide-hint">
				{review.progress.complete
					? "Slide to send · this is irreversible"
					: `Add ${review.progress.required - review.progress.collected} more signature(s) to send.`}
			</p>
			<input
				class="slider"
				type="range"
				min="0"
				max="100"
				bind:value={slide}
				onchange={confirmSend}
				disabled={sendBusy || !review.progress.complete}
				aria-label="Slide to send"
			/>
			<div class="review-actions">
				<button class="link-btn t-label" type="button" onclick={abandonDraft}>Cancel</button>
			</div>
		{/if}
	</section>
{/if}

<style>
	.hero {
		margin-bottom: var(--space-4);
	}
	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-2);
	}
	.hero .unit {
		font-size: 0.35em;
		color: var(--text-secondary);
	}
	.pending {
		color: var(--sage);
		margin-top: var(--space-1);
	}
	.meta {
		color: var(--text-muted);
		margin-top: var(--space-2);
	}
	.warn {
		color: var(--attention, var(--warning));
		margin-top: var(--space-2);
	}
	.tabs {
		display: flex;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}
	.tabs button {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: var(--t-label);
		font-weight: 500;
		padding: 6px 8px;
		cursor: pointer;
	}
	.tabs button.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	.tx-list,
	.coin-control {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.tx {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
	}
	.amt {
		font-variant-numeric: tabular-nums;
		color: var(--text);
		min-width: 96px;
	}
	.amt.recv {
		color: var(--sage);
	}
	.txid {
		font-family: var(--font-mono, ui-monospace, monospace);
		color: var(--text-muted);
		flex: 1;
	}
	.conf {
		color: var(--text-muted);
	}
	.addr {
		font-family: var(--font-mono, ui-monospace, monospace);
		word-break: break-all;
		background: var(--bg-input);
		padding: 12px;
		border-radius: var(--radius-input);
		margin: var(--space-2) 0 var(--space-3);
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
	}
	.adv-toggle,
	.link-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 0;
		font-family: var(--font-ui);
	}
	.coin {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 6px 0;
	}
	.coin .mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		flex: 1;
	}
	.coin-val {
		font-variant-numeric: tabular-nums;
	}
	.muted {
		color: var(--text-muted);
	}
	.err {
		color: var(--error);
	}
	.ok {
		color: var(--sage);
	}
	.review {
		margin: var(--space-2) 0 var(--space-3);
	}
	.review-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
	}
	.review-row .mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		word-break: break-all;
		text-align: right;
	}
	.review-amt {
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
	}
	.slide-hint {
		margin-top: var(--space-3);
	}
	.slider {
		width: 100%;
		accent-color: var(--accent);
	}
	.review-actions {
		margin-top: var(--space-2);
		text-align: center;
	}
</style>
