/**
 * Theme -- ONE source of truth (UX sweep hearth-i2x). Before this fix the
 * header `ThemeToggle` (every page) and `/me`'s Display radio group each had
 * their own independent idea of "the current theme": the toggle only ever
 * wrote `localStorage['hearth.theme']` + `<html data-theme>`; `/me` only ever
 * read/wrote the server-persisted `prefs.theme.<userId>` row via
 * `/api/me/prefs`. Nothing kept them in sync, so `/me` could show "System"
 * selected while the header toggle -- and the page you were looking at --
 * were actually in Dark.
 *
 * The device's rendered theme MUST stay driven by localStorage (app.html's
 * synchronous pre-paint script reads only `localStorage['hearth.theme']`, by
 * design, to avoid a flash-of-wrong-theme before hydration -- there is no way
 * to make that pre-paint step ask the server first). So `applyThemeLocally`
 * stays the single place that ever writes `localStorage`/`data-theme`, and
 * every control that changes the theme -- the header toggle AND `/me`'s
 * Display form -- now calls through it, then best-effort mirrors the choice
 * to the server-persisted preference (`/api/me/prefs`) so a second device (or
 * a page that still reads the DB value) agrees with whichever control was
 * used last, instead of the two silently drifting apart.
 */

export type ThemeChoice = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'hearth.theme';

/** The theme actually in effect on THIS device right now -- the same value
 *  app.html's pre-paint script and every previous ThemeToggle click read. */
export function readStoredTheme(): ThemeChoice {
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === 'dark' || stored === 'light' ? stored : 'system';
}

/** Apply `next` to THIS device: localStorage + <html data-theme>, the exact
 *  mechanism app.html's pre-paint script reads on the next load. */
export function applyThemeLocally(next: ThemeChoice): void {
	if (next === 'system') {
		localStorage.removeItem(STORAGE_KEY);
		document.documentElement.removeAttribute('data-theme');
	} else {
		localStorage.setItem(STORAGE_KEY, next);
		document.documentElement.setAttribute('data-theme', next);
	}
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
