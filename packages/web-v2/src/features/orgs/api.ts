import { apiClient } from "@/lib/api/client";
import type { AddOrgMemberInput, CreateOrgInput, OrgListItem, OrgMemberRow, OrgRole } from "./types";

export const orgsApi = {
  list: () => apiClient<OrgListItem[]>(`/orgs`),

  create: (input: CreateOrgInput) =>
    apiClient<OrgListItem>(`/orgs`, { method: "POST", body: JSON.stringify(input) }),

  rename: (orgId: string, name: string) =>
    apiClient<Omit<OrgListItem, "role">>(`/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  remove: (orgId: string) => apiClient<void>(`/orgs/${orgId}`, { method: "DELETE" }),

  listMembers: (orgId: string) => apiClient<OrgMemberRow[]>(`/orgs/${orgId}/members`),

  addMember: (orgId: string, input: AddOrgMemberInput) =>
    apiClient<OrgMemberRow>(`/orgs/${orgId}/members`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateMemberRole: (orgId: string, userId: string, role: OrgRole) =>
    apiClient<Omit<OrgMemberRow, "email">>(`/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  removeMember: (orgId: string, userId: string) =>
    apiClient<void>(`/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),
};
