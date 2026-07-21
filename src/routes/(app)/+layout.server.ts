import type { LayoutServerLoad } from './$types';
import { loadConfig } from '$lib/server/config/index.js';

/** Exposes the session user to the (app) group's layout/pages (topnav
 *  username + sign-out), and the advertised HTTPS port for the signing
 *  surface's secure-context hop (SIGNING.md §4.3) -- the client composes the
 *  hop URL from THIS value, never a literal 4489. */
export const load: LayoutServerLoad = ({ locals }) => {
	return { user: locals.user, httpsExternalPort: loadConfig().httpsExternalPort };
};
