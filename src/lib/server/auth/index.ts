/**
 * Auth module public surface (DECISIONS.md §4.3) -- password auth, sessions,
 * first-run bootstrap now; invites + three-tier role enforcement land in M3.
 * Other modules import from here only -- never reach into the sibling files
 * directly.
 */
export type Role = 'owner' | 'member' | 'guest';

export {
	hashPassword,
	verifyPassword,
	MIN_PASSWORD_LENGTH
} from './password.js';

export {
	SESSION_COOKIE,
	createSession,
	getSessionUser,
	destroySession,
	destroyUserSessions,
	cookieSecure,
	setSessionCookie,
	clearSessionCookie,
	hashToken,
	type SessionUser
} from './session.js';

export {
	AuthError,
	userCount,
	getUserById,
	loginWithPassword,
	bootstrapAdminFromEnv,
	mustResetPassword,
	completeForcedCredentialReset,
	type AuthUser
} from './users.js';

export {
	householdGreetingName,
	setHouseholdName,
	getHouseholdNameSetting,
	hasBeenWelcomed,
	markWelcomed
} from './household.js';

export { API_POLICY, resolveApiPolicy, type MinRole, type Rule } from './policy.js';
export { roleAtLeast, requireRole, requireWalletAccess } from './guard.js';
