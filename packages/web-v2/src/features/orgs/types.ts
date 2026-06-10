/** Org-tier types — mirror packages/core/src/orgs/routes.ts response shapes. */

export type OrgRole = "owner" | "admin" | "member";

/** One row of `GET /api/orgs` — an org the caller belongs to + their role. */
export interface OrgListItem {
  id: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  role: OrgRole;
  createdAt: string;
}

/** One row of `GET /api/orgs/:orgId/members`. */
export interface OrgMemberRow {
  userId: string;
  email: string;
  role: OrgRole;
  createdAt: string;
}

/** One row of `GET /api/orgs/:orgId/projects` — visible to any org member. */
export interface OrgProjectRow {
  id: string;
  slug: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

/** One row of `GET /api/orgs/:orgId/invitations` (org admin). `owner` is never
 *  invitable by email, so the role is admin|member only. */
export interface OrgInvitationRow {
  email: string;
  role: "admin" | "member";
  expiresAt: string;
  createdAt: string;
  inviterEmail: string;
  expired: boolean;
}

export interface CreateOrgInput {
  slug: string;
  name: string;
}

export interface AddOrgMemberInput {
  email: string;
  role: OrgRole;
}

/** `POST /api/orgs/:orgId/members` — 201 returns the inserted member row;
 *  202 means the email has no account yet and an invitation was sent. */
export type AddOrgMemberResult =
  | OrgMemberRow
  | { invited: true; expiresAt: string };
