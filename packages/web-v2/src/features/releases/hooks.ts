"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReleasePageViewKind } from "@forge/contracts/release-page";
import { releasesApi } from "./api";
import type { ReleaseDecisionBody } from "./types";

export function useReleases(projectId: string | undefined) {
  return useQuery({
    queryKey: ["releases", projectId ?? ""],
    queryFn: () => releasesApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useRelease(projectId: string | undefined, version: string | undefined) {
  return useQuery({
    queryKey: ["release", projectId ?? "", version ?? ""],
    queryFn: () => releasesApi.get(projectId as string, version as string),
    enabled: Boolean(projectId && version),
    staleTime: 0,
  });
}

/** How often a page owed a highlight draft is read again while it waits. */
const DRAFT_POLL_MS = 5_000;

export function useReleasePage(projectId: string | undefined, version: string | undefined, view: ReleasePageViewKind) {
  return useQuery({
    queryKey: ["release-page", projectId ?? "", version ?? "", view],
    queryFn: () => releasesApi.page(projectId as string, version as string, view),
    enabled: Boolean(projectId && version),
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.highlights.state === "pending" ? DRAFT_POLL_MS : false),
  });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["releases", projectId] });
    qc.invalidateQueries({ queryKey: ["release", projectId] });
    qc.invalidateQueries({ queryKey: ["release-page", projectId] });
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
