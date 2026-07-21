<script lang="ts">
	// Sign with QR (SIGNING.md §2.2.3) -- animated BBQr display + camera
	// scan-back. Show always works (any browser/context, display only);
	// Scan needs a secure context + Chromium's BarcodeDetector -- on plain
	// HTTP or an unsupported browser it falls back to a paste box rather than
	// erroring. BROWSER-SIDE component -- never imports $lib/server
	// (SIGNING.md §0.3).
	import { onDestroy } from 'svelte';
	import { encodePsbtToFramesDetailed, PsbtQrJoiner } from '$lib/hw/bbqr.js';
	import { startScan, type ScanHandle } from '$lib/hw/qrScan.js';
	import { cameraScanUnavailableReason } from '$lib/hw/secureContext.js';

	let {
		psbt,
		onsigned,
		onerror
	}: {
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
	} = $props();

	type Half = 'show' | 'scan';
	let half = $state<Half>('show');

	// ---- Show half: an animated APNG built once from the current PSBT.
	let showImgUrl = $state<string | null>(null);
	let showObjectUrl: string | null = null;

	function buildShowImage() {
		if (showObjectUrl) {
			URL.revokeObjectURL(showObjectUrl);
			showObjectUrl = null;
		}
		try {
			const { parts, version } = encodePsbtToFramesDetailed(psbt, { minSplit: 1 });
			// Lazy-import: rendering is the only piece of `bbqr` that touches a
			// browser canvas -- keep it out of any SSR/non-QR-user code path.
			import('bbqr').then(({ renderQRImage }) => {
				renderQRImage(parts, version, { mode: 'animated', frameDelay: 300 }).then((buf) => {
					const blob = new Blob([buf], { type: 'image/png' });
					showObjectUrl = URL.createObjectURL(blob);
					showImgUrl = showObjectUrl;
				});
			});
		} catch {
			onerror('Could not build the QR code for this transaction.');
		}
	}

	$effect(() => {
		if (half === 'show') buildShowImage();
	});

	// ---- Scan half: camera BarcodeDetector, or a paste fallback.
	let video = $state<HTMLVideoElement | undefined>(undefined);
	let scanHandle: ScanHandle | null = null;
	let joiner = new PsbtQrJoiner();
	let scanProgress = $state<{ have: number; total: number } | null>(null);
	let pasteText = $state('');

	const unavailableReason = $derived(cameraScanUnavailableReason());

	function stopScan() {
		scanHandle?.stop();
		scanHandle = null;
	}

	async function beginScan() {
		if (!video || unavailableReason !== 'ok') return;
		joiner = new PsbtQrJoiner();
		scanProgress = null;
		try {
			scanHandle = await startScan(video, onFrame);
		} catch (err) {
			onerror(err instanceof Error ? err.message : 'Could not start the camera.');
		}
	}

	function onFrame(text: string) {
		try {
			const { complete, progress } = joiner.add(text);
			scanProgress = progress;
			if (complete) {
				stopScan();
				onsigned(joiner.result());
			}
		} catch (err) {
			onerror(err instanceof Error ? err.message : "That's not a signed-transaction QR.");
			joiner.reset();
			scanProgress = null;
		}
	}

	function submitPaste() {
		const text = pasteText.trim();
		if (!text) return;
		onsigned(text);
	}

	function chooseHalf(next: Half) {
		if (half === 'scan') stopScan();
		half = next;
		if (next === 'scan') queueMicrotask(beginScan);
	}

	onDestroy(() => {
		stopScan();
		if (showObjectUrl) URL.revokeObjectURL(showObjectUrl);
	});
</script>

<div class="qr-sign">
	<div class="halves">
		<button class="half-btn t-label" type="button" class:active={half === 'show'} onclick={() => chooseHalf('show')}>
			Show
		</button>
		<button class="half-btn t-label" type="button" class:active={half === 'scan'} onclick={() => chooseHalf('scan')}>
			Scan back
		</button>
	</div>

	{#if half === 'show'}
		<p class="t-label muted">Scan this with your signer.</p>
		{#if showImgUrl}
			<img class="qr-img" src={showImgUrl} alt="Animated QR code of the transaction to sign" />
		{:else}
			<p class="t-label muted">Building the QR code…</p>
		{/if}
	{:else if unavailableReason === 'ok'}
		<p class="t-label muted">Point your camera at the signed transaction's QR.</p>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={video} class="scan-video" playsinline muted></video>
		{#if scanProgress}
			<p class="t-label progress">{scanProgress.have} of {scanProgress.total} frames</p>
		{/if}
	{:else if unavailableReason === 'unsupported-browser'}
		<p class="t-label muted">QR scan needs Chrome, Edge, or Brave -- or use Sign with file.</p>
	{:else}
		<!-- 'insecure-context' (a full nudge lands at T3) and 'no-camera' both
		     fall back to a paste box so the flow never dead-ends. -->
		<p class="t-label muted">
			{unavailableReason === 'insecure-context'
				? 'Camera scanning needs a secure connection. Paste the signed transaction text instead:'
				: 'No camera found. Paste the signed transaction text instead:'}
		</p>
		<textarea class="paste mono" rows="4" bind:value={pasteText} placeholder="Paste the signed transaction…"
		></textarea>
		<button class="btn-primary secondary" type="button" onclick={submitPaste} disabled={!pasteText.trim()}>
			Use this
		</button>
	{/if}
</div>

<style>
	.qr-sign {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.halves {
		display: flex;
		gap: var(--space-2);
	}
	.half-btn {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 6px 14px;
		cursor: pointer;
		color: var(--text-secondary);
		font-family: var(--font-ui);
	}
	.half-btn.active {
		color: var(--accent);
		border-color: var(--accent-dim);
	}
	.muted {
		color: var(--text-muted);
	}
	.qr-img {
		max-width: 260px;
		border-radius: var(--radius-input);
		background: #fff;
		padding: 8px;
	}
	.scan-video {
		width: 100%;
		max-width: 320px;
		border-radius: var(--radius-input);
		background: #000;
	}
	.progress {
		color: var(--attention, var(--warning));
	}
	.paste {
		width: 100%;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		color: var(--text);
		padding: 10px 12px;
		font-size: var(--t-body);
	}
	.paste.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
