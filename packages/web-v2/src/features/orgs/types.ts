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

export interface CreateOrgInput {
  slug: string;
  name: string;
}

export interface AddOrgMemberInput {
  email: string;
  role: OrgRole;
}
