<script lang="ts">
	// Wallets: the ONE unified engine list + universal import (DECISIONS.md
	// §4.2). Paste, drop, upload, or QR-scan ANY wallet config -- Caravan,
	// Coldcard .txt, Sparrow, descriptor, xpub, Hearth backup -- the server's
	// parse-config auto-detects and returns a preview; the user names it and
	// confirms. Single-sig and multisig are one code path.
	import { goto, invalidateAll } from '$app/navigation';
	import { formatSats as fmtSats } from '$lib/format.js';
	import Term from '$lib/components/Term.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface PlanPreview {
		kind: 'single' | 'multisig';
		scriptType: string;
		network: string;
		threshold: number;
		keyCount: number;
		keys: { fingerprint: string; path: string; xpub: string }[];
	}
	interface Plan {
		suggestedName: string | null;
		input: Record<string, unknown>;
		preview: PlanPreview;
	}
	interface Parsed {
		format: string;
		formatLabel: string;
		wallets: Plan[];
		notes: string[];
	}

	let showImport = $state(false);
	let payload = $state('');
	let busy = $state(false);
	let previewing = $state(false);
	let errorMsg = $state<string | null>(null);
	let parsed = $state<Parsed | null>(null);
	let names = $state<string[]>([]);
	let dragDepth = $state(0);
	let fileInput = $state<HTMLInputElement | null>(null);

	// QR scan
	let scanning = $state(false);
	let scanError = $state<string | null>(null);
	let videoEl = $state<HTMLVideoElement | null>(null);
	let scanHandle: { stop(): void } | null = null;

	function kindLabel(kind: string, threshold: number, keyCount: number): string {
		return kind === 'multisig' ? `${threshold}-of-${keyCount} multisig` : 'single-sig';
	}

	function shortKey(xpub: string): string {
		return xpub.length > 20 ? `${xpub.slice(0, 12)}…${xpub.slice(-6)}` : xpub;
	}

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	function onPayloadInput() {
		clearTimeout(debounceTimer);
		parsed = null;
		errorMsg = null;
		const value = payload;
		if (!value.trim()) return;
		debounceTimer = setTimeout(() => void preview(value, null), 450);
	}

	async function preview(content: string, filename: string | null) {
		previewing = true;
		errorMsg = null;
		try {
			const res = await fetch('/api/wallets/parse-config', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content, filename })
			});
			const j = await res.json().catch(() => null);
			if (!res.ok) {
				parsed = null;
				errorMsg = j?.message ?? "couldn't read that";
				return;
			}
			parsed = j as Parsed;
			names = parsed.wallets.map((w, i) => w.suggestedName ?? (parsed!.wallets.length > 1 ? `Wallet ${i + 1}` : ''));
		} catch {
			parsed = null;
			errorMsg = "couldn't reach the server -- try again";
		} finally {
			previewing = false;
		}
	}

	const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

	async function readDroppedFile(file: File) {
		showImport = true;
		parsed = null;
		errorMsg = null;
		if (file.size > 1_000_000) {
			errorMsg = 'that file is too large to be a wallet config';
			return;
		}
		const buf = new Uint8Array(await file.arrayBuffer());
		let content: string;
		if (buf.length >= 5 && PSBT_MAGIC.every((v, i) => buf[i] === v)) {
			// Binary PSBT: base64 it so the server can answer with the
			// points-at-the-signing-flow message.
			let bin = '';
			for (const b of buf) bin += String.fromCharCode(b);
			content = btoa(bin);
		} else {
			content = new TextDecoder().decode(buf);
		}
		payload = content;
		await preview(content, file.name);
	}

	function onFilePicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) void readDroppedFile(file);
		input.value = '';
	}

	function onWindowDrop(e: DragEvent) {
		e.preventDefault();
		dragDepth = 0;
		const file = e.dataTransfer?.files?.[0];
		if (file) void readDroppedFile(file);
	}

	async function startQrScan() {
		scanError = null;
		scanning = true;
		await Promise.resolve(); // let the <video> mount
		try {
			const { startScan } = await import('$lib/hw/qrScan.js');
			if (!videoEl) throw new Error('camera view failed to open');
			scanHandle = await startScan(videoEl, (text) => {
				stopQrScan();
				payload = text;
				void preview(text, null);
			});
		} catch (e) {
			scanning = false;
			scanError = e instanceof Error ? e.message : 'QR scanning is unavailable here';
		}
	}

	function stopQrScan() {
		scanHandle?.stop();
		scanHandle = null;
		scanning = false;
	}

	async function confirmImport(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed) return;
		errorMsg = null;
		busy = true;
		try {
			const createdIds: number[] = [];
			for (let i = 0; i < parsed.wallets.length; i++) {
				const plan = parsed.wallets[i];
				const walletName = names[i]?.trim() || plan.suggestedName || `Imported wallet ${i + 1}`;
				const res = await fetch('/api/wallets', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name: walletName, ...plan.input })
				});
				if (!res.ok) {
					const j = await res.json().catch(() => ({ message: 'import failed' }));
					errorMsg =
						parsed.wallets.length > 1
							? `"${walletName}": ${j.message ?? 'import failed'} (${createdIds.length} wallet(s) already imported)`
							: (j.message ?? 'import failed');
					if (createdIds.length > 0) await invalidateAll();
					return;
				}
				createdIds.push(((await res.json()) as { id: number }).id);
			}
			showImport = false;
			payload = '';
			parsed = null;
			await invalidateAll();
			if (createdIds.length === 1) await goto(`/wallets/${createdIds[0]}`);
		} catch {
			errorMsg = 'import failed -- try again';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window
	ondragenter={(e) => {
		if (e.dataTransfer?.types?.includes('Files')) dragDepth++;
	}}
	ondragleave={() => {
		if (dragDepth > 0) dragDepth--;
	}}
	ondragover={(e) => e.preventDefault()}
	ondrop={onWindowDrop}
/>

{#if dragDepth > 0}
	<div class="drop-overlay" aria-hidden="true">
		<p class="t-title">Drop your wallet file anywhere</p>
		<p class="t-label">Caravan · Coldcard · Sparrow · descriptor · Hearth backup</p>
	</div>
{/if}

<svelte:head>
	<title>Wallets -- Hearth</title>
</svelte:head>

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
		<div class="sources">
			<button class="btn-primary secondary" type="button" onclick={() => fileInput?.click()}>
				Upload a file
			</button>
			<button class="btn-primary secondary" type="button" onclick={() => (scanning ? stopQrScan() : void startQrScan())}>
				{scanning ? 'Stop scanning' : 'Scan a QR code'}
			</button>
			<input
				class="file-hidden"
				type="file"
				accept=".json,.txt,.psbt,text/plain,application/json,application/octet-stream"
				bind:this={fileInput}
				onchange={onFilePicked}
			/>
			<span class="t-label hint">…or drop a file anywhere on this page, or paste below.</span>
		</div>

		{#if scanning}
			<div class="scan-box">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} autoplay playsinline muted></video>
				<p class="t-label hint">Point the camera at an xpub or descriptor QR.</p>
			</div>
		{/if}
		{#if scanError}<p class="err t-label">{scanError}</p>{/if}

		<label class="field">
			<span class="t-label">Anything goes here</span>
			<textarea
				class="input mono"
				bind:value={payload}
				oninput={onPayloadInput}
				rows="4"
				placeholder="Paste a Caravan JSON, Coldcard multisig .txt, Sparrow export, descriptor, xpub/ypub/zpub, or a Hearth backup"
			></textarea>
		</label>
		<p class="hint t-label">
			Hearth auto-detects the format and shows a preview before anything is saved. Paste an
			<Term
				label="xpub/ypub/zpub"
				definition="An extended PUBLIC key -- it lets this node watch your addresses and balance. It cannot spend anything; your private key never leaves your own device."
			/>
			, a full output
			<Term
				label="descriptor"
				definition="A single string that fully describes a wallet's addresses (script type, keys, and derivation path) -- the modern, more precise alternative to a bare xpub."
			/>, or a config file from Caravan, Coldcard, Sparrow, or another Hearth. Keys stay yours;
			this node only watches.
		</p>

		{#if previewing}<p class="t-label hint">Reading…</p>{/if}
		{#if errorMsg}<p class="err t-label">{errorMsg}</p>{/if}

		{#if parsed}
			<form class="preview" onsubmit={confirmImport}>
				<div class="preview-head">
					<span class="badge t-label">{parsed.formatLabel}</span>
					{#if parsed.wallets.length > 1}
						<span class="t-label hint">{parsed.wallets.length} wallets in this file</span>
					{/if}
				</div>
				{#each parsed.notes as note (note)}
					<p class="note t-label">{note}</p>
				{/each}
				{#each parsed.wallets as plan, i (i)}
					<div class="preview-wallet hairline">
						<label class="field">
							<span class="t-label">Name</span>
							<input class="input" bind:value={names[i]} placeholder={plan.suggestedName ?? 'Spending'} required />
						</label>
						<p class="t-label summary">
							{kindLabel(plan.preview.kind, plan.preview.threshold, plan.preview.keyCount)}
							· {plan.preview.scriptType} · {plan.preview.network}
						</p>
						<ul class="key-list">
							{#each plan.preview.keys as k (k.xpub)}
								<li class="t-label">
									<span class="mono">{k.fingerprint}</span>
									<span class="mono path">{k.path}</span>
									<span class="mono">{shortKey(k.xpub)}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
				<button class="btn-primary" type="submit" disabled={busy}>
					{busy
						? 'Importing…'
						: parsed.wallets.length > 1
							? `Import ${parsed.wallets.length} wallets`
							: 'Import this wallet'}
				</button>
			</form>
		{/if}
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
						<span class="t-title wallet-name">{w.name}</span>
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
	<p class="backup-line t-label">
		<a href="/api/wallets/backup" download>Download a wallet backup</a> — names and public
		descriptors only; drop it on any Hearth to restore.
	</p>
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
	.drop-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		border: 2px dashed var(--accent);
		pointer-events: none;
	}
	.sources {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}
	.file-hidden {
		display: none;
	}
	.scan-box {
		margin-bottom: var(--space-3);
	}
	.scan-box video {
		width: 100%;
		max-width: 420px;
		border-radius: var(--radius-input);
		background: #000;
	}
	.preview {
		margin-top: var(--space-3);
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-3);
	}
	.preview-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.note {
		color: var(--warning, var(--text-secondary));
		margin: 0 0 var(--space-2);
	}
	.preview-wallet {
		padding: var(--space-2) 0;
	}
	.summary {
		color: var(--text-secondary);
		margin: 4px 0 var(--space-1);
	}
	.key-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.key-list li {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		color: var(--text-muted);
		padding: 2px 0;
	}
	.key-list .mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
	}
	.key-list .path {
		color: var(--text-secondary);
	}
	.backup-line {
		color: var(--text-muted);
		margin-top: var(--space-3);
	}
	.backup-line a {
		color: var(--text-secondary);
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
	.wallet-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 2px 10px;
		color: var(--text-secondary);
		white-space: nowrap;
		flex-shrink: 0;
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
