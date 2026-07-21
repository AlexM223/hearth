/**
 * qrScan.ts tests (SIGNING.md §5.2): fake BarcodeDetector + getUserMedia,
 * proving the poll loop, dedupe-left-to-caller behavior, stop() idempotency,
 * and the NotAllowedError vs generic getUserMedia failure mapping -- all
 * without a real camera.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScan } from './qrScan.js';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fakeVideo(): HTMLVideoElement {
	const attrs: Record<string, string> = {};
	return {
		srcObject: null,
		muted: false,
		readyState: 2,
		setAttribute: (k: string, v: string) => {
			attrs[k] = v;
		},
		play: async () => {},
		getAttribute: (k: string) => attrs[k]
	} as unknown as HTMLVideoElement;
}

class FakeBarcodeDetector {
	static results: { rawValue: string }[][] = [];
	static calls = 0;
	async detect() {
		const r = FakeBarcodeDetector.results[FakeBarcodeDetector.calls] ?? [];
		FakeBarcodeDetector.calls++;
		return r;
	}
}

function fakeTrack() {
	return { stop: vi.fn() };
}

function stubWorkingCamera(getUserMedia = vi.fn(async () => ({ getTracks: () => [fakeTrack()] }))) {
	vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
	vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
	return getUserMedia;
}

describe('qrScan.ts: startScan', () => {
	it('throws a plain-language error when BarcodeDetector is unsupported', async () => {
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
		await expect(startScan(fakeVideo(), () => {})).rejects.toThrow(/Chrome, Edge, or Brave/i);
	});

	it('throws when no camera API is available at all', async () => {
		vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
		vi.stubGlobal('navigator', {});
		await expect(startScan(fakeVideo(), () => {})).rejects.toThrow(/no camera/i);
	});

	it('requests facingMode:"environment", video-only, and sets playsinline+muted', async () => {
		const getUserMedia = stubWorkingCamera();
		const video = fakeVideo();
		const handle = await startScan(video, () => {});
		expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
		expect((video as unknown as { getAttribute: (k: string) => string }).getAttribute('playsinline')).toBe('true');
		expect(video.muted).toBe(true);
		handle.stop();
	});

	it('maps NotAllowedError to a calm permission message', async () => {
		const err = new Error('denied');
		err.name = 'NotAllowedError';
		stubWorkingCamera(vi.fn(async () => Promise.reject(err)));
		await expect(startScan(fakeVideo(), () => {})).rejects.toThrow(/blocked/i);
	});

	it('maps a generic getUserMedia failure to a generic message', async () => {
		stubWorkingCamera(vi.fn(async () => Promise.reject(new Error('boom'))));
		await expect(startScan(fakeVideo(), () => {})).rejects.toThrow(/could not start the camera/i);
	});

	it('decodes frames on a poll loop and calls onFrame for each rawValue', async () => {
		vi.useFakeTimers();
		FakeBarcodeDetector.calls = 0;
		FakeBarcodeDetector.results = [[{ rawValue: 'B$2P0100frame' }], [], [{ rawValue: 'B$2P0100frame' }]];
		stubWorkingCamera();
		const seen: string[] = [];
		const handle = await startScan(fakeVideo(), (text) => seen.push(text), { intervalMs: 50 });
		// First detect() already ran synchronously inside startScan's tick() kickoff.
		await vi.advanceTimersByTimeAsync(60);
		await vi.advanceTimersByTimeAsync(60);
		expect(seen).toEqual(['B$2P0100frame', 'B$2P0100frame']);
		handle.stop();
		vi.useRealTimers();
	});

	it('stop() is idempotent and stops every MediaStreamTrack', async () => {
		const track = fakeTrack();
		stubWorkingCamera(vi.fn(async () => ({ getTracks: () => [track] })));
		const handle = await startScan(fakeVideo(), () => {});
		handle.stop();
		handle.stop();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it('skips detect() while the video has no current frame (readyState < 2)', async () => {
		vi.useFakeTimers();
		FakeBarcodeDetector.calls = 0;
		FakeBarcodeDetector.results = [[{ rawValue: 'should-not-fire' }]];
		stubWorkingCamera();
		const seen: string[] = [];
		const video = fakeVideo();
		(video as unknown as { readyState: number }).readyState = 0;
		const handle = await startScan(video, (text) => seen.push(text), { intervalMs: 50 });
		await vi.advanceTimersByTimeAsync(60);
		expect(seen).toEqual([]);
		handle.stop();
		vi.useRealTimers();
	});
});
