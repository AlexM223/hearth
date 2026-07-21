<script lang="ts">
	// Tx detail (EXPLORER.md §3.4): a status pill (never red for merely
	// unconfirmed), amount/fee/rate, two hairline-separated in/out lists,
	// raw hex/scriptSig/witness behind Advanced.
	import { formatSats } from '$lib/format.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import FeeChip from '$lib/components/FeeChip.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let advanced = $state(false);
	let totalOut = $derived(data.detail ? data.detail.vout.reduce((s, o) => s + o.value, 0) : 0);

	function cpfpNote(cpfp: NonNullable<NonNullable<PageProps['data']['detail']>['cpfp']>): string | null {
		if (cpfp.boostedByDescendant) return 'Sped up by a later transaction';
		if (cpfp.bumpsAncestor) return 'Waiting on an earlier transaction';
		return null;
	}
</script>

<section class="panel">
	<a class="back t-label" href="/explorer">← Explorer</a>

	{#if data.unavailable || !data.detail}
		<DegradeBanner richness="none" noneMessage="This transaction needs a working node connection -- check Settings." />
	{:else}
		{@const detail = data.detail}
		<div class="status-row">
			<span class="pill" class:confirmed={detail.confirmed}>
				{detail.confirmed ? 'Confirmed' : 'Unconfirmed'}
			</span>
			{#if detail.cpfp && cpfpNote(detail.cpfp)}
				<span class="cpfp-note t-label">{cpfpNote(detail.cpfp)}</span>
			{/if}
			{#if detail.pool}
				<span class="pool-note t-label">⛏ {detail.pool.isYou ? 'You found this block!' : `Found by ${detail.pool.finderDisplayName}`}</span>
			{/if}
		</div>

		<div class="hash-row hairline">
			<span class="txid t-mono">{detail.txid}</span>
		</div>

		<div class="grid">
			<div><span class="t-label muted">Amount</span><span class="t-label value">{formatSats(totalOut)} sats</span></div>
			<div><span class="t-label muted">Fee</span><span class="t-label value">{detail.fee !== null ? `${formatSats(detail.fee)} sats` : '—'}</span></div>
			<div><span class="t-label muted">Fee rate</span><FeeChip feeRate={detail.feeRate} /></div>
			<div><span class="t-label muted">Confirmations</span><span class="t-label value">{formatSats(detail.confirmations)}</span></div>
		</div>

		{#if detail.blockContext.richness === 'basic'}
			<DegradeBanner richness="basic" basicMessage="Some block context is still being resolved." />
		{/if}

		{#if detail.blockHeight !== null}
			<p class="t-label block-link">
				In block <a href={`/explorer/block/${detail.blockHash}`}>{formatSats(detail.blockHeight)}</a>
			</p>
		{/if}

		<div class="lists">
			<div class="list">
				<p class="t-micro">Inputs</p>
				<ul>
					{#each detail.vin as vin, i (i)}
						<li class="hairline row">
							{#if vin.coinbase}
								<span class="t-label">Coinbase</span>
							{:else}
								{#if vin.address}
									<a class="t-mono addr" href={`/explorer/address/${vin.address}`}>{vin.address}</a>
								{:else}
									<span class="t-mono addr muted">unresolved</span>
								{/if}
								<span class="value t-label">{vin.value !== null ? `${formatSats(vin.value)} sats` : '—'}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
			<div class="list">
				<p class="t-micro">Outputs</p>
				<ul>
					{#each detail.vout as vout, i (i)}
						<li class="hairline row">
							{#if vout.address}
								<a class="t-mono addr" href={`/explorer/address/${vout.address}`}>{vout.address}</a>
							{:else}
								<span class="t-mono addr muted">{vout.scriptType}</span>
							{/if}
							<span class="value t-label">{formatSats(vout.value)} sats</span>
							<span
								class="dot"
								class:spent={vout.spent === true}
								class:unspent={vout.spent === false}
								title={vout.spent === null ? 'unknown' : vout.spent ? 'spent' : 'unspent'}
							></span>
						</li>
					{/each}
				</ul>
			</div>
		</div>

		<button class="adv-toggle t-label" type="button" onclick={() => (advanced = !advanced)}>
			{advanced ? '− Hide' : '+ Show'} advanced
		</button>
		{#if advanced}
			<div class="advanced">
				<p class="t-label muted">Version {detail.version} · Locktime {detail.locktime} · Size {detail.size} B · vsize {detail.vsize} vB · weight {detail.weight}</p>
				<p class="t-label muted">{detail.segwit ? 'SegWit' : 'Legacy'} · {detail.rbf ? 'RBF signaled' : 'No RBF signal'}</p>
				{#each detail.vin as vin, i (i)}
					{#if vin.scriptSigHex || vin.witness}
						<div class="raw-block">
							<p class="t-micro">Input {i}</p>
							{#if vin.scriptSigHex}<p class="t-mono raw">scriptSig: {vin.scriptSigHex}</p>{/if}
							{#if vin.witness}<p class="t-mono raw">witness: {vin.witness.join(' ')}</p>{/if}
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	{/if}
</section>

<style>
	.back {
		color: var(--text-secondary);
		text-decoration: none;
		display: inline-block;
		margin-bottom: var(--space-3);
	}

	.status-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}

	.pill {
		display: inline-flex;
		align-items: center;
		border-radius: var(--radius-pill);
		padding: 4px 14px;
		font-size: var(--t-label);
		font-weight: 500;
		color: var(--text-secondary);
		background: var(--surface-elevated);
	}

	.pill.confirmed {
		color: var(--sage);
	}

	.cpfp-note,
	.pool-note {
		color: var(--text-secondary);
	}

	.pool-note {
		color: var(--sage);
	}

	.hash-row {
		padding: var(--space-2) 0;
		margin-bottom: var(--space-2);
	}

	.txid {
		color: var(--text-secondary);
		word-break: break-all;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0;
	}

	.grid > div {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.muted {
		color: var(--text-muted);
	}

	.value {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.block-link a {
		color: var(--accent);
		text-decoration: none;
	}

	.lists {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
		margin-top: var(--space-4);
	}

	@media (max-width: 640px) {
		.lists {
			grid-template-columns: 1fr;
		}
	}

	.lists ul {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 8px 0;
	}

	.addr {
		color: var(--text-secondary);
		flex: 1;
		word-break: break-all;
		text-decoration: none;
	}

	.addr:not(.muted):hover {
		color: var(--accent);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--text-faint);
		flex-shrink: 0;
	}

	.dot.spent {
		background: var(--text-muted);
	}

	.dot.unspent {
		background: var(--sage);
	}

	.adv-toggle {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 0;
		margin-top: var(--space-4);
		font-family: var(--font-ui);
	}

	.advanced {
		margin-top: var(--space-2);
	}

	.raw-block {
		margin-top: var(--space-2);
	}

	.raw {
		color: var(--text-muted);
		word-break: break-all;
		font-size: var(--t-micro);
	}
</style>
