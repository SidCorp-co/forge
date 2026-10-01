"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { releaseVersionsApi } from "./versions-api";
import type { ReleaseDecisionBody } from "./versions-types";

export const releaseVersionsKey = (projectId: string) => ["release-versions", projectId] as const;
export const releaseVersionKey = (projectId: string, version: string) =>
  ["release-version", projectId, version] as const;

export function useReleaseVersions(projectId: string | undefined) {
  return useQuery({
    queryKey: releaseVersionsKey(projectId ?? ""),
    queryFn: () => releaseVersionsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useAwaitingApprovalCount(projectId: string | undefined): number | undefined {
  return useReleaseVersions(projectId).data?.counts.awaitingApproval;
}

export function useReleaseVersion(projectId: string | undefined, version: string | null) {
  return useQuery({
    queryKey: releaseVersionKey(projectId ?? "", version ?? ""),
    queryFn: () => releaseVersionsApi.get(projectId as string, version as string),
    enabled: Boolean(projectId && version),
    staleTime: 0,
  });
}

export function useReleaseDecision(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; approvalId: string; body: ReleaseDecisionBody }) =>
      releaseVersionsApi.decide(projectId, v.runId, v.approvalId, v.body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["release-versions", projectId] });
      qc.invalidateQueries({ queryKey: ["release-version", projectId] });
    },
  });
}

export function useCutRelease(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (issueIds: string[]) => releaseVersionsApi.cut(projectId, issueIds),
    onSettled: () => qc.invalidateQueries({ queryKey: ["release-versions", projectId] }),
  });
}
