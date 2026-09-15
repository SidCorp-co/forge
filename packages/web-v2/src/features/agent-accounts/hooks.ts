"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentAccountsApi } from "./api";
import type { AgentSelfPatch } from "./types";

const keys = {
  list: (orgId: string) => ["agent-accounts", orgId] as const,
  self: (orgId: string, agentUserId: string) => ["agent-accounts", orgId, "self", agentUserId] as const,
};

export function useAgentAccounts(orgId: string | null) {
  return useQuery({
    queryKey: keys.list(orgId ?? ""),
    queryFn: () => agentAccountsApi.list(orgId as string),
    enabled: !!orgId,
  });
}

export function useMintAgentCredential(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentUserId: string) =>
      agentAccountsApi.mintCredential(orgId as string, agentUserId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(orgId ?? "") }),
  });
}

export function useRevokeAgentCredentials(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentUserId: string) =>
      agentAccountsApi.revokeCredentials(orgId as string, agentUserId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(orgId ?? "") }),
  });
}

export function useSetAgentDisplayName(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { agentUserId: string; displayName: string | null }) =>
      agentAccountsApi.setDisplayName(orgId as string, args.agentUserId, args.displayName),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(orgId ?? "") }),
  });
}

export function useAgentSelf(orgId: string | null, agentUserId: string | null) {
  return useQuery({
    queryKey: keys.self(orgId ?? "", agentUserId ?? ""),
    queryFn: () => agentAccountsApi.getSelf(orgId as string, agentUserId as string),
    enabled: !!orgId && !!agentUserId,
  });
}

export function useUpdateAgentSelf(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { agentUserId: string; patch: AgentSelfPatch }) =>
      agentAccountsApi.updateSelf(orgId as string, args.agentUserId, args.patch),
    onSuccess: (_self, args) =>
      qc.invalidateQueries({ queryKey: keys.self(orgId ?? "", args.agentUserId) }),
  });
}
