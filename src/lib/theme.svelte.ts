/**
 * Theme -- ONE source of truth (UX sweep hearth-i2x, then hearth-7w6). Before
 * hearth-i2x the header `ThemeToggle` (every page) and `/me`'s Display radio
 * group each had their own independent idea of "the current theme": the
 * toggle only ever wrote `localStorage['hearth.theme']` + `<html
 * data-theme>`; `/me` only ever read/wrote the server-persisted
 * `prefs.theme.<userId>` row via `/api/me/prefs`. Nothing kept them in sync,
 * so `/me` could show "System" selected while the header toggle -- and the
 * page you were looking at -- were actually in Dark.
 *
 * hearth-i2x fixed the WRITE side (both controls now call through
 * applyThemeLocally/mirrorThemeToServer below) but left a residual READ-side
 * bug: `ThemeToggle` seeded its displayed label from a plain, non-reactive
 * `$state(readStoredTheme())` exactly once at mount, so it only ever updated
 * on ITS OWN clicks. The header lives in the shared layout and never
 * remounts on client-side navigation, so after changing the theme via /me's
 * Display form (no reload), the header kept showing the OLD label even
 * though localStorage/data-theme/the rendered page were already correct
 * everywhere else. hearth-7w6 closes that gap: `current` below is a real
 * Svelte 5 rune (hence this file's `.svelte.ts` extension, required for
 * runes to work outside a component), so every reader that goes through
 * `getTheme()` in a reactive context (a `$derived`, an effect, a template
 * expression) re-renders the instant EITHER control changes it -- including
 * a `storage` event from another tab, via `handleStorageEvent` below.
 *
 * The device's rendered theme MUST stay driven by localStorage (app.html's
 * synchronous pre-paint script reads only `localStorage['hearth.theme']`, by
 * design, to avoid a flash-of-wrong-theme before hydration -- there is no way
 * to make that pre-paint step ask the server first). So `applyThemeLocally`
 * stays the single place that ever writes `localStorage`/`data-theme` (and
 * now also the shared `current` rune), and every control that changes the
 * theme -- the header toggle AND `/me`'s Display form -- now calls through
 * it, then best-effort mirrors the choice to the server-persisted preference
 * (`/api/me/prefs`) so a second device (or a page that still reads the DB
 * value) agrees with whichever control was used last, instead of the two
 * silently drifting apart.
 */

export type ThemeChoice = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'hearth.theme';

function readFromStorage(): ThemeChoice {
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === 'dark' || stored === 'light' ? stored : 'system';
}

/** The single shared reactive source every reader (header ThemeToggle, /me's
 *  Display form) derives its displayed state from. Seeded once from
 *  localStorage at module load (same as the old per-component seed), then
 *  kept in sync by every subsequent applyThemeLocally() call and by
 *  handleStorageEvent() below -- from ANY reader, not just the one that
 *  triggered the change. */
let current = $state<ThemeChoice>(readFromStorage());

/** Reactive read: call this from a component's template/`$derived`/`$effect`
 *  -- NOT once into a local variable -- so the caller re-renders on every
 *  change, from either control, in this tab or (via handleStorageEvent)
 *  another one. This is what fixes hearth-7w6. */
export function getTheme(): ThemeChoice {
	return current;
}

/** The theme actually in effect on THIS device right now -- the same value
 *  app.html's pre-paint script reads. A one-shot, non-reactive read straight
 *  from localStorage; prefer getTheme() above from inside a component so the
 *  read stays live. Kept (and still exported) because it's a simple,
 *  independently useful primitive -- e.g. seeding a one-off local $state
 *  that the user then edits before submitting, as /me's radio group does. */
export function readStoredTheme(): ThemeChoice {
	return readFromStorage();
}

/** Apply `next` to THIS device: localStorage + <html data-theme>, the exact
 *  mechanism app.html's pre-paint script reads on the next load -- and the
 *  shared `current` rune, so every other reader in this tab updates too. */
export function applyThemeLocally(next: ThemeChoice): void {
	if (next === 'system') {
		localStorage.removeItem(STORAGE_KEY);
		document.documentElement.removeAttribute('data-theme');
	} else {
		localStorage.setItem(STORAGE_KEY, next);
		document.documentElement.setAttribute('data-theme', next);
	}
	current = next;
}

/** Cross-tab correctness: another tab writing `hearth.theme` fires a
 *  `storage` event in every OTHER tab (never the one that wrote it), so pick
 *  that up and refresh `current` from localStorage. Exported as a plain
 *  function (rather than only wired up inline below) so it's directly
 *  unit-testable in this repo's plain-Node Vitest environment, which has no
 *  real `window`/`StorageEvent` to dispatch against. */
export function handleStorageEvent(event: { key: string | null }): void {
	if (event.key === STORAGE_KEY || event.key === null) {
		current = readFromStorage();
	}
}

if (typeof window !== 'undefined') {
	window.addEventListener('storage', handleStorageEvent);
}

/** Best-effort mirror to the server-persisted account preference so /me (or
 *  a second device) agrees with the last choice made here. Never throws --
 *  the device's own rendered theme (above) is authoritative and must never
 *  depend on this succeeding. An anonymous caller (e.g. the /login or
 *  /join/[code] ThemeToggle) simply gets a 401 from the API, silently
 *  swallowed here -- there's no account to persist to yet. */
export async function mirrorThemeToServer(next: ThemeChoice): Promise<void> {
	try {
		await fetch('/api/me/prefs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: next })
		});
	} catch {
		// best-effort only
	}
}
