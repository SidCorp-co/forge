"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReleasePageViewKind } from "@forge/contracts/release-page";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { releasesApi } from "./api";
import type { ReleaseDecisionBody } from "./types";

export const useReleases = (projectId: string | undefined) => useQuery(readOf(["releases", projectId], () => releasesApi.list(projectId as string)));

export const useRelease = (projectId: string | undefined, version: string | undefined) =>
  useQuery(readOf(["release", projectId, version], () => releasesApi.get(projectId as string, version as string), 0));

/** How often a page owed a highlight draft is read again while it waits. */
const DRAFT_POLL_MS = 5_000;

export const useReleasePage = (projectId: string | undefined, version: string | undefined, view: ReleasePageViewKind) =>
  useQuery({
    ...readOf(["release-page", projectId, version, view], () => releasesApi.page(projectId as string, version as string, view), 0),
    refetchInterval: (q) => (q.state.data?.highlights.state === "pending" ? DRAFT_POLL_MS : false),
  });

/** Every release read of the project, which a decision or a cut changes. */
const touched = (projectId: string) => [["releases", projectId], ["release", projectId], ["release-page", projectId]];

export const useReleaseDecision = (projectId: string) =>
  useWrite((v: { runId: string; approvalId: string; body: ReleaseDecisionBody }) => releasesApi.decide(projectId, v.runId, v.approvalId, v.body), { touches: touched(projectId) });

export const useCutRelease = (projectId: string) => useWrite((issueIds: string[]) => releasesApi.cut(projectId, issueIds), { touches: touched(projectId) });
