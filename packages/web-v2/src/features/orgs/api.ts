import { apiClient } from "@/lib/api/client";
import type {
  AddOrgMemberInput,
  AddOrgMemberResult,
  CreateOrgInput,
  MemberLens,
  OrgInvitationRow,
  OrgListItem,
  OrgMemberRow,
  OrgProjectRow,
  OrgRole,
} from "./types";

export const orgsApi = {
  list: () => apiClient<OrgListItem[]>(`/orgs`),

  create: (input: CreateOrgInput) =>
    apiClient<OrgListItem>(`/orgs`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  rename: (orgId: string, name: string) =>
    apiClient<Omit<OrgListItem, "role">>(`/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  remove: (orgId: string) =>
    apiClient<void>(`/orgs/${orgId}`, { method: "DELETE" }),

  listMembers: (orgId: string) =>
    apiClient<OrgMemberRow[]>(`/orgs/${orgId}/members`),

  /** `GET /api/orgs/:orgId/projects` — name/slug projection (org member+). */
  listProjects: (orgId: string) =>
    apiClient<OrgProjectRow[]>(`/orgs/${orgId}/projects`),

  /** 201 = member added directly; 202 `{ invited: true }` = no account yet,
   *  an email invitation was sent instead. */
  addMember: (orgId: string, input: AddOrgMemberInput) =>
    apiClient<AddOrgMemberResult>(`/orgs/${orgId}/members`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** `GET /api/orgs/:orgId/invitations` — pending invitations (org admin). */
  listInvitations: (orgId: string) =>
    apiClient<OrgInvitationRow[]>(`/orgs/${orgId}/invitations`),

  /** `DELETE /api/orgs/:orgId/invitations?email=` — revoke a pending invitation. */
  revokeInvitation: (orgId: string, email: string) =>
    apiClient<void>(
      `/orgs/${orgId}/invitations?email=${encodeURIComponent(email)}`,
      {
        method: "DELETE",
      },
    ),

  updateMemberRole: (orgId: string, userId: string, role: OrgRole) =>
    apiClient<Omit<OrgMemberRow, "email">>(`/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  /** Assign the member's soft working lens(es) — same PATCH endpoint, `lenses`
   *  body (role-aware chat). Sends the full desired set (server dedupes). */
  updateMemberLenses: (orgId: string, userId: string, lenses: MemberLens[]) =>
    apiClient<Omit<OrgMemberRow, "email">>(`/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ lenses }),
    }),

  removeMember: (orgId: string, userId: string) =>
    apiClient<void>(`/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),
};
