import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orgsApi } from "./api";
import type { AddOrgMemberInput, CreateOrgInput, OrgRole } from "./types";

const keys = {
  list: ["orgs"] as const,
  members: (orgId: string) => ["orgs", orgId, "members"] as const,
};

export function useOrgs() {
  return useQuery({ queryKey: keys.list, queryFn: orgsApi.list });
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrgInput) => orgsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list }),
  });
}

export function useRenameOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => orgsApi.rename(orgId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list }),
  });
}

export function useDeleteOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orgId: string) => orgsApi.remove(orgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list }),
  });
}

export function useOrgMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.members(orgId ?? "none"),
    queryFn: () => orgsApi.listMembers(orgId as string),
    enabled: !!orgId,
  });
}

export function useAddOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddOrgMemberInput) => orgsApi.addMember(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(orgId) }),
  });
}

export function useUpdateOrgMemberRole(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      orgsApi.updateMemberRole(orgId, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(orgId) }),
  });
}

export function useRemoveOrgMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => orgsApi.removeMember(orgId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(orgId) }),
  });
}
