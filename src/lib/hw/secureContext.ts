/**
 * Secure-context capability probes (SIGNING.md §0.3, §4.2). BROWSER-SIDE ONLY.
 * The single source of truth for "can this browser/origin do X" -- never sniff
 * the URL; a method tile decides purely from `window.isSecureContext` plus a
 * feature probe. SSR-safe: every probe checks `typeof window/navigator` first
 * so importing this module at the top of a `.svelte` file never touches a
 * browser global during server-side rendering.
 */

/** `window.isSecureContext` is the single source of truth for "secure
 *  context" (localhost counts by definition; a plain-HTTP LAN origin like
 *  Umbrel's app_proxy does not). `undefined` during SSR reads as `false` --
 *  callers must re-check after mount, not trust a server-rendered value. */
export function secureOrigin(): boolean {
	return typeof window !== 'undefined' && window.isSecureContext === true;
}

/** WebHID (Ledger) -- Chromium desktop only, needs a secure context. */
export function isWebHidAvailable(): boolean {
	return typeof navigator !== 'undefined' && Boolean((navigator as { hid?: unknown }).hid);
}

/** Web Serial (live Jade signing, Stage 3) -- Chromium desktop only, needs a
 *  secure context. No driver in `src/lib/hw` uses this today: hearth-ui7
 *  assessed the only available library (`jadets`) and declined to build on
 *  it (unmaintained, a confirmed unfixed signing-path bug). Kept as a
 *  capability probe in case that assessment is revisited. */
export function isWebSerialAvailable(): boolean {
	return typeof navigator !== 'undefined' && Boolean((navigator as { serial?: unknown }).serial);
}

interface BarcodeDetectorCtor {
	new (opts?: { formats?: string[] }): unknown;
}

function barcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
	if (typeof globalThis === 'undefined') return undefined;
	return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

/** Camera QR scan-back needs: a secure context, `navigator.mediaDevices`, and
 *  the browser-native `BarcodeDetector` (Chromium-only; no jsQR/zxing --
 *  SIGNING.md §1.6 deliberately doesn't own a Reed-Solomon decoder). */
export function isCameraScanAvailable(): boolean {
	return cameraScanUnavailableReason() === 'ok';
}

export type CameraScanUnavailableReason = 'ok' | 'insecure-context' | 'unsupported-browser' | 'no-camera';

/** Exact check order is load-bearing (SIGNING.md §1.6): an insecure context
 *  withholds `navigator.mediaDevices` entirely in real browsers, so the
 *  secure-context check MUST run first, or an insecure-context case would be
 *  misdiagnosed as `'no-camera'` instead of the actionable `'insecure-context'`. */
export function cameraScanUnavailableReason(): CameraScanUnavailableReason {
	if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure-context';
	if (
		typeof navigator === 'undefined' ||
		!navigator.mediaDevices ||
		typeof navigator.mediaDevices.getUserMedia !== 'function'
	) {
		return 'no-camera';
	}
	if (barcodeDetectorCtor() === undefined) return 'unsupported-browser';
	return 'ok';
}

/** Which signing methods this run needs a secure context for (SIGNING.md
 *  §4.2). Trezor (popup) and file/QR-display never need one; the camera
 *  scan-back half of QR and any WebHID/WebSerial device do. */
export type SigningMethod = 'file' | 'qr-show' | 'qr-scan' | 'ledger' | 'trezor' | 'bitbox02' | 'jade';

export function needsSecureContext(method: SigningMethod): boolean {
	return method === 'qr-scan' || method === 'ledger' || method === 'jade';
	// 'bitbox02' intentionally excluded from this Stage-1 gate -- Stage 2
	// (BitBoxBridge) is filed as future work (hearth-mhp), not built.
}

/** Build the HTTPS-hop URL for the calm secure-context nudge (SIGNING.md
 *  §4.3). Composed from the CURRENT host + the advertised HTTPS port --
 *  NEVER a literal 4489 -- so the user lands on the same draft/review screen
 *  on the secure origin. */
export function secureHopUrl(
	loc: { hostname: string; pathname: string; search: string },
	httpsExternalPort: number
): string {
	return `https://${loc.hostname}:${httpsExternalPort}${loc.pathname}${loc.search}`;
}
