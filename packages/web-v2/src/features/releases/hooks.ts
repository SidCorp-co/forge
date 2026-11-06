
import { useQuery } from "@tanstack/react-query";
import type { ReleasePageViewKind } from "@forge/contracts/release-page";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { releasesApi } from "./api";
import type { ReleaseDecisionBody } from "./types";

/** The project's whole release list: the Releases page's read, and no other page's (ISS-1070). */
export const useReleases = (projectId: string | undefined) => useQuery(readOf(["releases", projectId], () => releasesApi.list(projectId as string)));

/** The newest `limit` releases that shipped, newest first, under the list's key so a decision or a cut refreshes them too. */
export const useShippedReleases = (projectId: string | undefined, limit: number) =>
  useQuery(readOf(["releases", projectId, "shipped", limit], () => releasesApi.shipped(projectId as string, limit)));

export const useRelease = (projectId: string | undefined, version: string | undefined) =>
  useQuery(readOf(["release", projectId, version], () => releasesApi.get(projectId as string, version as string), 0));

export const useReleasePage = (projectId: string | undefined, version: string | undefined, view: ReleasePageViewKind) =>
  useQuery(readOf(["release-page", projectId, version, view], () => releasesApi.page(projectId as string, version as string, view), 0));

/** Every release read of the project, which a decision or a cut changes. */
const touched = (projectId: string) => [["releases", projectId], ["release", projectId], ["release-page", projectId]];

export const useReleaseDecision = (projectId: string) =>
  useWrite((v: { runId: string; approvalId: string; body: ReleaseDecisionBody }) => releasesApi.decide(projectId, v.runId, v.approvalId, v.body), { touches: touched(projectId) });

export const useDraftDecision = (projectId: string) =>
  useWrite((v: { version: string; body: ReleaseDecisionBody }) => releasesApi.decideDraft(projectId, v.version, v.body), { touches: touched(projectId) });

export const useCutRelease = (projectId: string) => useWrite((issueIds: string[]) => releasesApi.cut(projectId, issueIds), { touches: touched(projectId) });
