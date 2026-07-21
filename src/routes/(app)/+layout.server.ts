import type { LayoutServerLoad } from './$types';

/** Exposes the session user to the (app) group's layout/pages (topnav username + sign-out). */
export const load: LayoutServerLoad = ({ locals }) => {
	return { user: locals.user };
};
