/**
 * secureContext.ts capability-probe tests (SIGNING.md §5.4). Node/Vitest has
 * no real `window`/`navigator`/`BarcodeDetector` -- every probe is exercised
 * via `vi.stubGlobal`, matching cairn's own qrScan test pattern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	cameraScanUnavailableReason,
	isCameraScanAvailable,
	isWebHidAvailable,
	isWebSerialAvailable,
	needsSecureContext,
	secureHopUrl,
	secureOrigin
} from './secureContext.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('secureOrigin / isWebHidAvailable / isWebSerialAvailable', () => {
	it('secureOrigin is false with no window (SSR / bare Node)', () => {
		expect(secureOrigin()).toBe(false);
	});

	it('secureOrigin reflects window.isSecureContext', () => {
		vi.stubGlobal('window', { isSecureContext: true });
		expect(secureOrigin()).toBe(true);
		vi.stubGlobal('window', { isSecureContext: false });
		expect(secureOrigin()).toBe(false);
	});

	it('isWebHidAvailable is false with no navigator.hid', () => {
		expect(isWebHidAvailable()).toBe(false);
		vi.stubGlobal('navigator', {});
		expect(isWebHidAvailable()).toBe(false);
	});

	it('isWebHidAvailable is true when navigator.hid exists', () => {
		vi.stubGlobal('navigator', { hid: {} });
		expect(isWebHidAvailable()).toBe(true);
	});

	it('isWebSerialAvailable mirrors the same shape for navigator.serial', () => {
		expect(isWebSerialAvailable()).toBe(false);
		vi.stubGlobal('navigator', { serial: {} });
		expect(isWebSerialAvailable()).toBe(true);
	});
});

class FakeBarcodeDetector {
	async detect() {
		return [];
	}
}

function stubWorkingCameraEnv() {
	vi.stubGlobal('window', { isSecureContext: true });
	vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
	vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
}

describe('cameraScanUnavailableReason -- exact check order is load-bearing', () => {
	it('insecure-context is checked FIRST, even with fully-working mediaDevices/BarcodeDetector stubbed', () => {
		stubWorkingCameraEnv();
		vi.stubGlobal('window', { isSecureContext: false });
		expect(cameraScanUnavailableReason()).toBe('insecure-context');
	});

	it('no-camera when mediaDevices is absent on an otherwise-secure context', () => {
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', {});
		expect(cameraScanUnavailableReason()).toBe('no-camera');
	});

	it('unsupported-browser when BarcodeDetector is absent (e.g. Firefox/Safari)', () => {
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
		expect(cameraScanUnavailableReason()).toBe('unsupported-browser');
	});

	it('ok when secure + mediaDevices + BarcodeDetector all present', () => {
		stubWorkingCameraEnv();
		expect(cameraScanUnavailableReason()).toBe('ok');
		expect(isCameraScanAvailable()).toBe(true);
	});
});

describe('needsSecureContext', () => {
	it('file, qr-show, and trezor never need a secure context', () => {
		expect(needsSecureContext('file')).toBe(false);
		expect(needsSecureContext('qr-show')).toBe(false);
		expect(needsSecureContext('trezor')).toBe(false);
	});

	it('qr-scan and ledger need a secure context', () => {
		expect(needsSecureContext('qr-scan')).toBe(true);
		expect(needsSecureContext('ledger')).toBe(true);
	});
});

describe('secureHopUrl -- composed from config, never a literal port', () => {
	it('builds https://<host>:<httpsExternalPort><path><search> from the current location', () => {
		const url = secureHopUrl(
			{ hostname: 'hearth.local', pathname: '/wallets/3', search: '?tab=send' },
			4489
		);
		expect(url).toBe('https://hearth.local:4489/wallets/3?tab=send');
	});

	it('uses whatever port is passed -- never hardcodes 4489', () => {
		const url = secureHopUrl({ hostname: 'localhost', pathname: '/', search: '' }, 9443);
		expect(url).toBe('https://localhost:9443/');
	});
});
