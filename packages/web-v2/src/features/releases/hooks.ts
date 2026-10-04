"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { releasesApi } from "./api";
import type { ReleaseDecisionBody } from "./types";

export const releasesKey = (projectId: string) => ["releases", projectId] as const;
export const releaseKey = (projectId: string, version: string) => ["release", projectId, version] as const;

export function useReleases(projectId: string | undefined) {
  return useQuery({
    queryKey: releasesKey(projectId ?? ""),
    queryFn: () => releasesApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useAwaitingApprovalCount(projectId: string | undefined): number | undefined {
  return useReleases(projectId).data?.counts.you;
}

export function useRelease(projectId: string | undefined, version: string | undefined) {
  return useQuery({
    queryKey: releaseKey(projectId ?? "", version ?? ""),
    queryFn: () => releasesApi.get(projectId as string, version as string),
    enabled: Boolean(projectId && version),
    staleTime: 0,
  });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["releases", projectId] });
    qc.invalidateQueries({ queryKey: ["release", projectId] });
  };
}

export function useReleaseDecision(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (v: { runId: string; approvalId: string; body: ReleaseDecisionBody }) =>
      releasesApi.decide(projectId, v.runId, v.approvalId, v.body),
    onSettled: invalidate,
  });
}

export function useCutRelease(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (issueIds: string[]) => releasesApi.cut(projectId, issueIds),
    onSettled: invalidate,
  });
}
