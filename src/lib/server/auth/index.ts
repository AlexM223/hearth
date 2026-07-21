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
	markWelcomed,
	guestSeesHouseholdBalance,
	setGuestSeesHouseholdBalance
} from './household.js';

export {
	updateOwnProfile,
	getOwnPrefs,
	setOwnTheme,
	type UpdateProfileInput,
	type OwnPrefs
} from './self.js';

export { API_POLICY, resolveApiPolicy, type MinRole, type Rule } from './policy.js';
export { roleAtLeast, requireRole, requireWalletAccess } from './guard.js';
export { touchLastActive, resetActivityThrottle } from './activity.js';

export {
	InviteError,
	generateInviteCode,
	hashInviteCode,
	createInvite,
	listInvites,
	getInvite,
	revokeInvite,
	lookupActiveInvite,
	type InviteRole,
	type InviteState,
	type InviteRow,
	type CreateInviteInput,
	type CreatedInvite
} from './invites.js';

export { acceptInvite, AcceptInviteError, type AcceptInviteInput, type AcceptedMember } from './accept.js';

export {
	listMembers,
	householdSummary,
	activityBucket,
	changeMemberRole,
	offboardMember,
	MemberError,
	type MemberRow,
	type ActivityBucket,
	type HouseholdSummary,
	type WalletBalanceReader,
	type OffboardWalletPolicy
} from './members.js';
