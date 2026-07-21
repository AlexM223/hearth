/**
 * Regression test for hearth-71z (UX sweep finding #2): the sweep measured
 * ~955px of un-collapsing top-nav chrome (brand + nav links + search +
 * actions) at a 375px viewport -- forcing `document.body.scrollWidth` to
 * ~1071px (site-wide, since every page shares this header) with NO `@media`
 * query anywhere in the shared layout. This is a source-level assertion (no
 * component-test harness in this repo -- see mining/keyed-lists.spec.ts):
 * a disclosure toggle exists, is hidden on desktop, and a breakpoint hides
 * the nav/search/actions behind it until opened.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const layoutPath = fileURLToPath(new URL('./+layout.svelte', import.meta.url));
const source = readFileSync(layoutPath, 'utf8');

describe('(app) shared layout collapses its top nav below 768px (hearth-71z)', () => {
	it('has a disclosure toggle wired to mobileMenuOpen state', () => {
		expect(source).toMatch(/mobileMenuOpen\s*=\s*\$state\(false\)/);
		expect(source).toContain('class="menu-toggle"');
		expect(source).toMatch(/onclick=\{\(\) => \(mobileMenuOpen = !mobileMenuOpen\)\}/);
	});

	it('the toggle is hidden by default (desktop) and only shown under a max-width breakpoint', () => {
		expect(source).toMatch(/\.menu-toggle\s*\{\s*display:\s*none;\s*\}/);
		expect(source).toMatch(/@media \(max-width:\s*768px\)/);
	});

	it('nav, search, and topnav-actions are hidden under the breakpoint unless the menu is open', () => {
		// Inside the @media block: collapsed by default...
		expect(source).toMatch(/nav\s*\{[^}]*display:\s*none;/s);
		expect(source).toMatch(/\.search\s*\{[^}]*display:\s*none;/s);
		expect(source).toMatch(/\.topnav-actions\s*\{[^}]*display:\s*none;/s);
		// ...revealed only via the .menu-open state class (set from mobileMenuOpen).
		expect(source).toContain('.topnav.menu-open nav');
		expect(source).toContain('.topnav.menu-open .search');
		expect(source).toContain('.topnav.menu-open .topnav-actions');
		expect(source).toContain('class:menu-open={mobileMenuOpen}');
	});

	it('every nav link closes the mobile menu on click (no stuck-open menu after navigating)', () => {
		// The nav {#each} link and the settings/profile link both close on click.
		const navLinkClicks = (source.match(/onclick=\{closeMobileMenu\}/g) ?? []).length;
		expect(navLinkClicks).toBeGreaterThanOrEqual(2);
	});
});
