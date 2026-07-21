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
import {
	readStoredTheme,
	applyThemeLocally,
	mirrorThemeToServer,
	getTheme,
	handleStorageEvent
} from './theme.svelte.js';

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

	describe('getTheme() is a single SHARED reactive source, not a per-caller snapshot (hearth-7w6)', () => {
		// Regression for hearth-7w6: ThemeToggle used to seed a private,
		// non-reactive `$state(readStoredTheme())` once at mount, so it only
		// ever reflected ITS OWN clicks -- after /me's Display form changed the
		// theme (a "different reader"), the header kept showing the stale
		// value. getTheme() must return the NEW value to every caller the
		// instant ANY caller applies a change, with no re-mount / re-read
		// needed in between -- that's what makes it "shared", not just
		// "another way to read localStorage".

		it('reflects a change made by one reader immediately, for every other reader, with no re-import or re-read needed', () => {
			applyThemeLocally('dark');
			// Simulates the header ThemeToggle's $derived(getTheme()) re-evaluating
			// after /me's Display form (a different call site) applied the change.
			expect(getTheme()).toBe('dark');

			applyThemeLocally('light');
			expect(getTheme()).toBe('light');
		});

		it('getTheme() and readStoredTheme() agree after every applyThemeLocally() call', () => {
			applyThemeLocally('dark');
			expect(getTheme()).toBe(readStoredTheme());
			applyThemeLocally('system');
			expect(getTheme()).toBe(readStoredTheme());
		});
	});

	describe('handleStorageEvent() keeps the shared source correct across tabs (hearth-7w6)', () => {
		// There's no real `window`/`StorageEvent` in this repo's plain-Node
		// Vitest environment (see the file header), so this calls the exported
		// handler directly with a duck-typed event -- exactly the shape the
		// real `window.addEventListener('storage', handleStorageEvent)` wiring
		// in theme.svelte.ts passes it.

		it('refreshes current from localStorage when another tab changes the watched key', () => {
			applyThemeLocally('system');
			expect(getTheme()).toBe('system');

			// Another tab wrote 'dark' directly to the (shared, per-origin)
			// localStorage -- this tab's own `current` doesn't know yet until
			// the storage event arrives.
			storage.setItem('hearth.theme', 'dark');
			handleStorageEvent({ key: 'hearth.theme' });
			expect(getTheme()).toBe('dark');
		});

		it('ignores storage events for unrelated keys', () => {
			applyThemeLocally('light');
			storage.setItem('some.other.key', 'irrelevant');
			handleStorageEvent({ key: 'some.other.key' });
			expect(getTheme()).toBe('light');
		});

		it('treats a null key (localStorage.clear()) as "re-read everything", per the storage-event spec', () => {
			applyThemeLocally('dark');
			storage.removeItem('hearth.theme');
			handleStorageEvent({ key: null });
			expect(getTheme()).toBe('system');
		});
	});
});
