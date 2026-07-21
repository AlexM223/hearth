/**
 * Camera QR scan-back (SIGNING.md §1.6) -- browser-native BarcodeDetector,
 * no jsQR/zxing (Reed-Solomon decode off a noisy webcam is a large
 * failure-prone thing to own; Chromium ships this natively). SSR-safe: no
 * `window`/`navigator`/`document` touched at module load. BROWSER-SIDE ONLY.
 * Availability probes live in secureContext.ts; this module is the actual
 * capture/decode loop.
 */

interface DetectedBarcode {
	rawValue: string;
}
interface BarcodeDetectorLike {
	detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
	new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

function barcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
	if (typeof globalThis === 'undefined') return undefined;
	return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

export interface ScanHandle {
	stop(): void;
}

export interface StartScanOptions {
	/** Poll interval between detect() calls, ms. Default 200. */
	intervalMs?: number;
	onError?: (err: Error) => void;
}

/** Start decoding QR frames from `video`'s live camera feed, calling
 *  `onFrame(text)` for every decoded barcode. Uses `facingMode: 'environment'`
 *  (rear camera on a phone; a laptop's only camera otherwise). Polls with a
 *  `setTimeout` chained after each `detect()` completes (never `setInterval`)
 *  so a slow detect() never overlaps/queues the next one. A single failed
 *  detect() is not fatal -- retried next tick. Caller is responsible for
 *  deduping decoded text (PsbtQrJoiner already tolerates repeat/out-of-order
 *  reads). */
export async function startScan(
	video: HTMLVideoElement,
	onFrame: (text: string) => void,
	opts: StartScanOptions = {}
): Promise<ScanHandle> {
	const Ctor = barcodeDetectorCtor();
	if (!Ctor) throw new Error('QR scanning needs Chrome, Edge, or Brave -- or use Sign with file.');
	if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
		throw new Error('No camera is available on this device.');
	}

	const intervalMs = opts.intervalMs ?? 200;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: 'environment' },
			audio: false
		});
	} catch (err) {
		const message =
			err instanceof Error && err.name === 'NotAllowedError'
				? 'Camera access was blocked -- allow it in the browser to scan.'
				: `Could not start the camera: ${err instanceof Error ? err.message : String(err)}`;
		const wrapped = new Error(message);
		opts.onError?.(wrapped);
		throw wrapped;
	}

	video.srcObject = stream;
	video.setAttribute('playsinline', 'true'); // keeps iOS Safari from going fullscreen
	video.muted = true;
	await video.play().catch(() => {}); // autoplay rejection tolerated, not fatal

	const detector = new Ctor({ formats: ['qr_code'] });

	const tick = async () => {
		if (stopped) return;
		try {
			if (video.readyState >= 2) {
				// HAVE_CURRENT_DATA
				const codes = await detector.detect(video);
				for (const c of codes) if (c?.rawValue) onFrame(c.rawValue);
			}
		} catch {
			// Transient decode glitch -- try again next tick.
		}
		if (!stopped) timer = setTimeout(tick, intervalMs);
	};
	tick();

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		for (const track of stream.getTracks()) track.stop();
		try {
			video.srcObject = null;
		} catch {
			// Some environments throw on reassignment during teardown -- ignore.
		}
	};

	return { stop };
}
