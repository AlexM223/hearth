<script lang="ts">
	// Sign with QR (SIGNING.md §2.2.3) -- animated QR display + camera
	// scan-back, in either of two codecs: BBQr (SeedSigner, Passport,
	// Coldcard-Q, Jade-BBQr-mode) or BC-UR (Keystone, Jade-QR mode --
	// SIGNING.md §1.7, hearth-ui7 T8). Show always works (any browser/context,
	// display only); Scan needs a secure context + Chromium's BarcodeDetector
	// -- on plain HTTP or an unsupported browser it falls back to a paste box
	// rather than erroring. BROWSER-SIDE component -- never imports
	// $lib/server (SIGNING.md §0.3).
	import { onDestroy } from 'svelte';
	import { encodePsbtToFramesDetailed, PsbtQrJoiner as BbqrJoiner, looksLikeBbqrFrame } from '$lib/hw/bbqr.js';
	import { encodePsbtToFrames as encodeUrFrames, PsbtQrJoiner as UrJoiner, looksLikeUrFrame } from '$lib/hw/jadeUr.js';
	import { startScan, type ScanHandle } from '$lib/hw/qrScan.js';
	import { cameraScanUnavailableReason } from '$lib/hw/secureContext.js';
	import SecureContextNudge from './SecureContextNudge.svelte';

	let {
		psbt,
		onsigned,
		onerror,
		httpsExternalPort = null
	}: {
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
		httpsExternalPort?: number | null;
	} = $props();

	type Half = 'show' | 'scan';
	let half = $state<Half>('show');

	// The "Show" codec choice -- BBQr (Stage 1) or BC-UR (Stage 3, Keystone /
	// Jade-QR). Scan-back doesn't need this: it auto-detects whichever codec
	// the first scanned frame looks like (see QrJoinerLike below).
	type ShowCodec = 'bbqr' | 'bcur';
	let showCodec = $state<ShowCodec>('bbqr');

	// ---- Show half: an animated image built once from the current PSBT --
	// BBQr renders as a single animated APNG (bbqr's own renderer); BC-UR has
	// no such renderer of its own, so it's a set of plain QR PNGs (via the
	// `qrcode` package) cycled on the same ~300ms cadence as bbqr's frames.
	let showImgUrl = $state<string | null>(null);
	let showObjectUrl: string | null = null;
	let urCycleTimer: ReturnType<typeof setInterval> | null = null;

	function stopUrCycle() {
		if (urCycleTimer !== null) {
			clearInterval(urCycleTimer);
			urCycleTimer = null;
		}
	}

	function buildShowImage() {
		stopUrCycle();
		if (showObjectUrl) {
			URL.revokeObjectURL(showObjectUrl);
			showObjectUrl = null;
		}
		showImgUrl = null;
		if (showCodec === 'bbqr') {
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
			return;
		}

		// BC-UR: render each `ur:crypto-psbt/...` frame as its own QR PNG (data
		// URL -- no Blob/object-URL lifetime to manage) and cycle through them.
		try {
			const frames = encodeUrFrames(psbt);
			import('qrcode').then(async (QRCode) => {
				const urls = await Promise.all(frames.map((f) => QRCode.toDataURL(f, { margin: 1, width: 300 })));
				if (urls.length === 0) return;
				showImgUrl = urls[0];
				if (urls.length > 1) {
					let i = 0;
					urCycleTimer = setInterval(() => {
						i = (i + 1) % urls.length;
						showImgUrl = urls[i];
					}, 300);
				}
			});
		} catch {
			onerror('Could not build the QR code for this transaction.');
		}
	}

	function chooseShowCodec(next: ShowCodec) {
		showCodec = next;
		buildShowImage();
	}

	$effect(() => {
		if (half === 'show') buildShowImage();
	});

	// ---- Scan half: camera BarcodeDetector, or a paste fallback. The codec
	// is auto-detected from the first scanned frame -- both joiners share the
	// same add/progress/result shape, so the caller doesn't need to know
	// which one it ended up with.
	interface QrJoinerLike {
		add(frame: string): { complete: boolean; progress: { have: number; total: number } };
		progress(): { have: number; total: number };
		result(): string;
		reset(): void;
	}

	function pickJoiner(frame: string): QrJoinerLike {
		return looksLikeUrFrame(frame) ? new UrJoiner() : new BbqrJoiner();
	}

	let video = $state<HTMLVideoElement | undefined>(undefined);
	let scanHandle: ScanHandle | null = null;
	let joiner: QrJoinerLike | null = null;
	let scanProgress = $state<{ have: number; total: number } | null>(null);
	let pasteText = $state('');

	const unavailableReason = $derived(cameraScanUnavailableReason());

	function stopScan() {
		scanHandle?.stop();
		scanHandle = null;
	}

	async function beginScan() {
		if (!video || unavailableReason !== 'ok') return;
		joiner = null;
		scanProgress = null;
		try {
			scanHandle = await startScan(video, onFrame);
		} catch (err) {
			onerror(err instanceof Error ? err.message : 'Could not start the camera.');
		}
	}

	function onFrame(text: string) {
		try {
			if (!joiner) joiner = pickJoiner(text);
			const { complete, progress } = joiner.add(text);
			scanProgress = progress;
			if (complete) {
				stopScan();
				onsigned(joiner.result());
			}
		} catch (err) {
			onerror(err instanceof Error ? err.message : "That's not a signed-transaction QR.");
			// Drop the joiner entirely, not just reset it -- a bad frame might
			// belong to a different codec than the one auto-detected so far, so
			// the next frame should get a fresh pickJoiner() chance too.
			joiner = null;
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
		stopUrCycle();
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
		<div class="codecs">
			<button class="codec-btn t-label" type="button" class:active={showCodec === 'bbqr'} onclick={() => chooseShowCodec('bbqr')}>
				BBQr
			</button>
			<button class="codec-btn t-label" type="button" class:active={showCodec === 'bcur'} onclick={() => chooseShowCodec('bcur')}>
				BC-UR (Keystone, Jade)
			</button>
		</div>
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
		{#if unavailableReason === 'insecure-context'}
			<SecureContextNudge what="Camera scanning" {httpsExternalPort} />
		{/if}
		<!-- Either way (insecure-context OR no-camera), a paste fallback keeps
		     the flow from dead-ending -- SIGNING.md §2.2.3 offers the nudge OR
		     the paste box for the insecure-context case; both together here. -->
		<p class="t-label muted">
			{unavailableReason === 'insecure-context'
				? 'Or paste the signed transaction text instead:'
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
	.halves,
	.codecs {
		display: flex;
		gap: var(--space-2);
	}
	.half-btn,
	.codec-btn {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 6px 14px;
		cursor: pointer;
		color: var(--text-secondary);
		font-family: var(--font-ui);
	}
	.codec-btn {
		padding: 4px 10px;
		font-size: var(--t-micro, 0.75rem);
	}
	.half-btn.active,
	.codec-btn.active {
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
