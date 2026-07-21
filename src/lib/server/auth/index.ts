/**
 * Auth module -- password auth, sessions, invites, roles (DECISIONS.md §4.3).
 * Stub for M0. Built in M1 (scrypt password auth + `hearth_session` cookie,
 * deterministic first-run admin) and M3 (invite-by-link, three-tier roles).
 */
export type Role = 'owner' | 'member' | 'guest';

export interface SessionUser {
	id: number;
	username: string;
	role: Role;
}
