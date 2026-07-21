<script lang="ts">
	// The mining dashboard (MINING-ENGINE.md §6): one page, role-gated sections.
	// Guest sees the shared pool view; Member additionally sees their own
	// connection/workers/odds; Owner additionally sees the admin aggregate +
	// settings form. Chart line is --text-secondary (data, not a control) --
	// DECISIONS.md §3 reserves the amber accent for the primary button + nav
	// (a deliberate deviation from MINING-ENGINE.md §6.2's literal text, which
	// says the hashrate hero uses --t-hero/Newsreader -- DECISIONS.md §3
	// reserves that exclusively for the wallet balance and wins per the
	// constitution's own precedence rule; the explorer's fee headline hit the
	// identical conflict and resolved it the same way with .t-stat).
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { formatSats } from '$lib/format.js';
	import { formatHashrate } from '$lib/shared/hashrate.js';
	import DegradeBanner from '$lib/components/DegradeBanner.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	function timeAgo(sec: number | null): string {
		if (sec === null) return 'never';
		if (sec < 60) return `${sec}s ago`;
		if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
		if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
		return `${Math.round(sec / 86400)}d ago`;
	}

	function engineStatusText(status: 'running' | 'stopped' | 'core_missing' | undefined): string {
		if (status === 'running') return 'Mining engine running';
		if (status === 'core_missing') return 'Mining needs your Bitcoin Core node connected first';
		return 'Mining is off';
	}

	// Live nudge (T7): a mining/mining:pool SSE event refetches this page's own
	// load() so hashrate/trophy/leaderboard rows stay current without a poll loop.
	onMount(() => {
		const source = new EventSource('/api/events');
		let pending = false;
		function nudge() {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				void invalidateAll();
			}, 400); // debounce a burst of nudges into one reload
		}
		source.addEventListener('mining', nudge);
		source.addEventListener('mining:pool', nudge);
		return () => source.close();
	});

	/** Zero-build inline SVG line path over a hashrate series (nodeview
	 *  pattern, MINING-ENGINE.md §6.2) -- --text-secondary, never amber. */
	function linePath(points: { t: number; hashrate: number }[], width: number, height: number): string {
		if (points.length === 0) return '';
		if (points.length === 1) return `M 0 ${height / 2} L ${width} ${height / 2}`;
		const minT = points[0]!.t;
		const maxT = points[points.length - 1]!.t;
		const spanT = Math.max(1, maxT - minT);
		const maxH = Math.max(1, ...points.map((p) => p.hashrate));
		const coords = points.map((p) => {
			const x = ((p.t - minT) / spanT) * width;
			const y = height - (p.hashrate / maxH) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return `M ${coords.join(' L ')}`;
	}

	let poolChartPath = $derived(linePath(data.pool?.hashrateSeries ?? [], 860, 120));
	let adminChartPath = $derived(linePath(data.admin?.hashrateSeries ?? [], 860, 120));

	let bestSharePct = $derived(
		data.mine?.networkDifficulty && data.mine.networkDifficulty > 0
			? Math.min(100, (data.mine.totals.bestShareEver / data.mine.networkDifficulty) * 100)
			: null
	);
</script>

<section class="panel status hairline">
	<p class="t-micro">Mining</p>
	<h1 class="t-title">{engineStatusText((data.mine ?? data.pool)?.engine.status)}</h1>
	{#if (data.mine ?? data.pool)?.engine.status !== 'running'}
		<p class="t-label">
			Solo mining is a lottery, not a salary — most instances never find a block, and that's normal.
			When it's on, your miner grinds toward the same jackpot as the whole network; if you win, the
			<strong>full reward pays your own wallet</strong>, never split.
		</p>
	{/if}
	{#if data.loadError}
		<DegradeBanner richness="none" noneMessage={data.loadError} />
	{/if}
</section>

{#if data.role === 'member' || data.role === 'owner'}
	<section class="panel connection hairline">
		<p class="t-micro">Your mining</p>
		<form method="POST" action="?/toggleMining" use:enhance class="enable-row">
			<label class="toggle">
				<input
					type="checkbox"
					name="enabled"
					checked={data.mine?.connection !== null}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				/>
				<span class="t-label">Enable mining for my account</span>
			</label>
		</form>

		{#if data.mine?.connection}
			{@const c = data.mine.connection}
			<div class="conn-details">
				<p class="t-label">Point your miner at this node:</p>
				<ul class="conn-lines t-mono">
					<li>stratum+tcp://{data.hostname}:{data.mine.engine.stratumPort}</li>
					{#if data.mine.engine.asicPort}
						<li>
							stratum+tcp://{data.hostname}:{data.mine.engine.asicPort.port}
							<span class="t-label">(big machines here)</span>
						</li>
					{/if}
					<li>username: {c.workerFormat}</li>
					<li>password: {c.password}</li>
				</ul>
				<form method="POST" action="?/regenerateId" use:enhance>
					<button class="link-btn t-label" type="submit">Rotate my mining id</button>
				</form>
			</div>

			<form method="POST" action="?/setPayout" use:enhance class="payout-form">
				<p class="t-label">Reward payout wallet (gets the FULL reward, never split):</p>
				<select name="walletId" value={data.mine.payout?.walletId ?? ''}>
					<option value="">— choose a wallet —</option>
					{#each data.mine.wallets.filter((w) => w.eligible) as w (w.id)}
						<option value={w.id}>{w.name}</option>
					{/each}
				</select>
				<button class="btn-primary" type="submit">Save</button>
			</form>
			{#if form?.error}<p class="t-label error">{form.error}</p>{/if}
		{/if}
	</section>

	{#if data.mine}
		<section class="panel hero-section hairline">
			<p class="t-micro">Your hashrate now</p>
			<p class="t-stat">{formatHashrate(data.mine.totals.hashrateNow)}</p>
			<p class="t-label">24h: {formatHashrate(data.mine.totals.hashrate24h)}</p>
			{#if data.mine.odds}
				<p class="t-label odds">
					At this hashrate, about
					<strong
						>~{data.mine.odds.expectedYearsPerBlock < 1
							? `${Math.round(data.mine.odds.expectedYearsPerBlock * 365)} days`
							: `${data.mine.odds.expectedYearsPerBlock.toFixed(1)} years`}</strong
					>
					per block — never an earnings estimate, solo mining is all-or-nothing.
				</p>
			{:else}
				<p class="t-label">Odds appear once your miner is submitting shares.</p>
			{/if}
		</section>

		<section class="panel trophy hairline">
			<p class="t-micro">Best share ever</p>
			<p class="t-stat">{Math.round(data.mine.totals.bestShareEver).toLocaleString()}</p>
			{#if bestSharePct !== null}
				<p class="t-label">≈{bestSharePct.toFixed(4)}% of the way to a block</p>
			{/if}
		</section>

		<section class="panel workers hairline">
			<p class="t-micro">Your workers</p>
			{#if data.mine.workers.length === 0}
				<p class="t-label">No workers connected yet.</p>
			{:else}
				<table>
					<thead>
						<tr class="t-label">
							<th>Worker</th>
							<th>Hashrate</th>
							<th>Last share</th>
							<th>Shares</th>
							<th>Best</th>
						</tr>
					</thead>
					<tbody>
						{#each data.mine.workers as w (w.name)}
							<tr class="hairline">
								<td class="t-label">
									<span class="dot" class:dot-ok={w.online} class:dot-down={!w.online}></span>
									{w.name}
								</td>
								<td class="t-mono">{formatHashrate(w.hashrate.now)}</td>
								<td class="t-label">{timeAgo(w.lastShareAgoSec)}</td>
								<td class="t-mono">{w.shares.accepted}</td>
								<td class="t-mono">{Math.round(w.bestShareDifficulty).toLocaleString()}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		{#if data.mine.earnings.blocksFound.length > 0}
			<section class="panel blocks hairline">
				<p class="t-micro">Blocks you found</p>
				<ul class="block-list">
					{#each data.mine.earnings.blocksFound as b (b.height)}
						<li class="hairline">
							<span class="t-mono">{formatSats(b.height)}</span>
							<span class="t-label status-{b.status}">{b.status}</span>
							<span class="t-mono">{formatSats(b.reward)} sats</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
{:else}
	<section class="panel hairline">
		<p class="t-label">Ask your host to turn on mining for your account.</p>
	</section>
{/if}

<section class="panel pool hairline">
	<p class="t-micro">The pool</p>
	<p class="t-stat">{formatHashrate(data.pool?.pool.hashrateNow ?? null)}</p>
	<p class="t-label">
		{data.pool?.pool.connectedWorkers ?? 0} workers · {data.pool?.pool.connectedUsers ?? 0} miners online ·
		{data.pool?.totalBlocksFound ?? 0} blocks found
	</p>
	<svg viewBox="0 0 860 120" role="img" aria-label="Pool hashrate, last 24 hours" class="chart">
		<path d={poolChartPath} fill="none" stroke="var(--text-secondary)" stroke-width="1.5" />
	</svg>

	{#if data.pool?.bestShare}
		<p class="t-label trophy-line">
			Pool best share: <strong>{Math.round(data.pool.bestShare.difficulty).toLocaleString()}</strong>
			by {data.pool.bestShare.isYou ? 'you' : data.pool.bestShare.holderName}
		</p>
	{/if}

	{#if data.pool && data.pool.leaderboard.length > 0}
		<ol class="leaderboard">
			{#each data.pool.leaderboard as l (l.rank)}
				<li class="hairline t-label" class:you={l.isYou}>
					<span class="rank t-mono">#{l.rank}</span>
					{l.isYou ? 'You' : l.name}
					<span class="t-mono">{Math.round(l.bestShareDifficulty).toLocaleString()}</span>
				</li>
			{/each}
		</ol>
	{/if}

	{#if data.pool && data.pool.blocks.length > 0}
		<ul class="block-list">
			{#each data.pool.blocks as b (b.blockHash)}
				<li class="hairline t-label">
					<span class="t-mono">{formatSats(b.height)}</span>
					{b.isYou ? 'You' : b.foundByName}
					<span class="status-{b.status}">{b.status}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if data.role === 'owner' && data.admin}
	<section class="panel admin hairline">
		<p class="t-micro">Owner: engine status</p>
		<p class="t-label">
			Core RPC: {data.admin.engine.coreRpc} · uptime {Math.round(data.admin.engine.uptimeSec / 60)}m ·
			listeners: {data.admin.engine.listeners.map((l) => `${l.role}:${l.port} (${l.connections})`).join(', ') ||
				'—'}
		</p>
		{#if data.admin.engine.fatalErrors.length > 0}
			<ul class="fatal-list">
				{#each data.admin.engine.fatalErrors as msg, i (i)}
					<li class="t-label error">{msg}</li>
				{/each}
			</ul>
		{/if}

		<svg viewBox="0 0 860 120" role="img" aria-label="Pool hashrate (admin), last 24 hours" class="chart">
			<path d={adminChartPath} fill="none" stroke="var(--text-secondary)" stroke-width="1.5" />
		</svg>

		<table>
			<thead>
				<tr class="t-label"><th>Miner</th><th>Worker</th><th>Hashrate</th><th>Last share</th></tr>
			</thead>
			<tbody>
				{#each data.admin.miners as m (`${m.userId}:${m.worker}`)}
					<tr class="hairline">
						<td class="t-label">{m.userName}</td>
						<td class="t-label">{m.worker}</td>
						<td class="t-mono">{formatHashrate(m.hashrate)}</td>
						<td class="t-label">{timeAgo(m.lastShareAgoSec)}</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<form method="POST" action="?/saveSettings" use:enhance class="settings-form">
			<label class="toggle">
				<input type="checkbox" name="mining_enabled" checked={data.admin.settings.enabled} />
				<span class="t-label">Mining enabled (operator setting)</span>
			</label>
			<label class="t-label">
				Bind
				<select name="mining_bind" value={data.admin.settings.bind}>
					<option value="loopback">loopback only</option>
					<option value="lan">LAN</option>
					<option value="all">all interfaces</option>
				</select>
			</label>
			<label class="t-label">
				Standard port
				<input type="number" name="mining_stratum_port" value={data.admin.settings.port} />
			</label>
			<label class="t-label">
				Share difficulty floor
				<input type="number" step="any" name="mining_share_difficulty" value={data.admin.settings.shareDifficulty} />
			</label>
			<label class="toggle">
				<input type="checkbox" name="mining_vardiff_enabled" checked={data.admin.settings.vardiffEnabled} />
				<span class="t-label">Variable difficulty</span>
			</label>
			<label class="t-label">
				Pool tag
				<input type="text" name="mining_pool_tag" value={data.admin.settings.poolTag} maxlength="20" />
			</label>
			<label class="toggle">
				<input type="checkbox" name="mining_asic_port_enabled" checked={data.admin.settings.asicPortEnabled} />
				<span class="t-label">ASIC-floor port ({data.admin.settings.asicStratumPort})</span>
			</label>
			<button class="btn-primary" type="submit">Save settings</button>
		</form>
	</section>
{/if}

<style>
	.status h1 {
		margin: 4px 0 var(--space-2);
	}

	.enable-row {
		margin-bottom: var(--space-2);
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.conn-details,
	.payout-form {
		margin-top: var(--space-2);
	}

	.conn-lines {
		list-style: none;
		margin: var(--space-1) 0;
		padding: 0;
		color: var(--text);
	}

	.conn-lines li {
		padding: 2px 0;
	}

	.link-btn {
		background: none;
		border: none;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
		font-family: var(--font-ui);
	}

	.payout-form select,
	.settings-form select,
	.settings-form input {
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 8px 10px;
		color: var(--text);
		font-family: var(--font-ui);
		margin: 4px 0 var(--space-2);
	}

	.odds {
		margin-top: var(--space-2);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: var(--space-2);
	}

	td,
	th {
		text-align: left;
		padding: 8px 6px;
	}

	.dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		margin-right: 6px;
	}

	.dot-ok {
		background: var(--sage);
	}

	.dot-down {
		background: var(--text-faint);
	}

	.chart {
		width: 100%;
		height: auto;
		margin: var(--space-3) 0;
	}

	.block-list {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.block-list li {
		display: flex;
		gap: var(--space-2);
		padding: 8px 0;
		align-items: center;
	}

	.leaderboard {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.leaderboard li {
		display: flex;
		gap: var(--space-2);
		padding: 6px 0;
		align-items: center;
	}

	.leaderboard .you {
		color: var(--text);
		font-weight: 600;
	}

	.rank {
		min-width: 32px;
		color: var(--text-muted);
	}

	.status-mature {
		color: var(--sage);
	}

	.status-maturing {
		color: var(--attention);
	}

	.status-rejected {
		color: var(--error);
	}

	.error {
		color: var(--error);
	}

	.fatal-list {
		list-style: none;
		margin: var(--space-2) 0;
		padding: 0;
	}

	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: var(--space-3);
		max-width: 360px;
	}

	section.panel + section.panel {
		margin-top: var(--space-4);
	}
</style>
