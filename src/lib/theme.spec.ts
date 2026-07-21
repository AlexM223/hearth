/**
 * Regression test for hearth-i2x (UX sweep finding #6, Medium): the header
 * `ThemeToggle` and `/me`'s Display radio group each kept their own
 * independent notion of "the current theme" -- the toggle only ever wrote
 * `localStorage`; `/me` only ever read/wrote the server-persisted DB row.
 * The sweep reproduced them actively disagreeing (header live in Dark,
 * `/me` showing "System" checked) on the same session.
 *
 * `$lib/theme.ts` is the single implementation both `ThemeToggle.svelte` and
 * `/me/+page.svelte` now call through (see theme-single-source.spec.ts for
 * the source-level proof of that wiring). This file tests theme.ts's actual
 * runtime behavior. There is no jsdom/component-test harness in this repo
 * (see mining/keyed-lists.spec.ts), so `localStorage`/`document` don't exist
 * in the plain Node vitest environment -- rather than skip real behavior
 * testing, this stubs minimal duck-typed globals covering exactly the
 * Storage/Element subset theme.ts touches.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readStoredTheme, applyThemeLocally, mirrorThemeToServer } from './theme.js';

function fakeStorage() {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	};
}

function fakeDocument() {
	const attrs = new Map<string, string>();
	return {
		documentElement: {
			setAttribute: (k: string, v: string) => void attrs.set(k, v),
			removeAttribute: (k: string) => void attrs.delete(k),
			getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null)
		}
	};
}

describe('theme.ts: localStorage stays the single client-side source of truth (hearth-i2x)', () => {
	let storage: ReturnType<typeof fakeStorage>;
	let doc: ReturnType<typeof fakeDocument>;

	beforeEach(() => {
		storage = fakeStorage();
		doc = fakeDocument();
		vi.stubGlobal('localStorage', storage);
		vi.stubGlobal('document', doc);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('readStoredTheme() defaults to "system" with nothing stored', () => {
		expect(readStoredTheme()).toBe('system');
	});

	it('readStoredTheme() defaults to "system" when localStorage itself is unavailable (private-mode fallback)', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(readStoredTheme()).toBe('system');
	});

	it('applyThemeLocally("dark") sets localStorage AND <html data-theme> together', () => {
		applyThemeLocally('dark');
		expect(storage.getItem('hearth.theme')).toBe('dark');
		expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('applyThemeLocally("system") clears both (falls back to prefers-color-scheme)', () => {
		applyThemeLocally('light');
		applyThemeLocally('system');
		expect(storage.getItem('hearth.theme')).toBeNull();
		expect(doc.documentElement.getAttribute('data-theme')).toBeNull();
	});

	it('readStoredTheme() reflects whatever was last applied -- this is the exact value /me now reads on mount instead of the (possibly stale) server-persisted prefs.theme', () => {
		applyThemeLocally('light');
		expect(readStoredTheme()).toBe('light');
		applyThemeLocally('dark');
		expect(readStoredTheme()).toBe('dark');
	});

	it('mirrorThemeToServer() never throws even when the network call fails (best-effort, device stays authoritative)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new Error('network down'))
		);
		await expect(mirrorThemeToServer('dark')).resolves.toBeUndefined();
	});

	it('mirrorThemeToServer() posts the choice to /api/me/prefs', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await mirrorThemeToServer('light');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/me/prefs',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ theme: 'light' }) })
		);
	});
});
