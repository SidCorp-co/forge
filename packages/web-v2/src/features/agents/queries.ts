// The agents feature's reads: the runs read model's key factory and its queryOptions. Every key sits
// under `runs-standing`, so a write that moves a run invalidates them all (lib/ws/event-router.ts).
import { queryOptions } from "@tanstack/react-query";
import { runsApi } from "./api";
import type { RunStandingScope } from "./types";

const RUNS_POLL_MS = 20_000;

/** Every key the runs read model answers under; a write that moves a run invalidates it. */
export const RUNS_STANDING_ROOT = "runs-standing";

export const runKeys = {
  project: (projectId: string | undefined) => [RUNS_STANDING_ROOT, projectId] as const,
  standing: (projectId: string | undefined, scope: RunStandingScope) => [...runKeys.project(projectId), "list", scope] as const,
  run: (projectId: string | undefined, runId: string) => [...runKeys.project(projectId), "run", runId] as const,
  master: (projectId: string | undefined) => [...runKeys.project(projectId), "master"] as const,
  passes: (projectId: string | undefined) => [...runKeys.project(projectId), "passes"] as const,
  charter: (projectId: string | undefined) => [...runKeys.project(projectId), "charter"] as const,
};

export const runQueries = {
  standing: (projectId: string | undefined, scope: RunStandingScope) =>
    queryOptions({
      queryKey: runKeys.standing(projectId, scope),
      queryFn: () => runsApi.standing(projectId as string, scope),
      enabled: !!projectId,
      refetchInterval: RUNS_POLL_MS,
    }),
  run: (projectId: string | undefined, runId: string) =>
    queryOptions({
      queryKey: runKeys.run(projectId, runId),
      queryFn: () => runsApi.run(projectId as string, runId),
      enabled: !!projectId && !!runId,
      refetchInterval: RUNS_POLL_MS,
    }),
  master: (projectId: string | undefined) =>
    queryOptions({ queryKey: runKeys.master(projectId), queryFn: () => runsApi.master(projectId as string), enabled: !!projectId, refetchInterval: RUNS_POLL_MS }),
  passes: (projectId: string | undefined) =>
    queryOptions({ queryKey: runKeys.passes(projectId), queryFn: () => runsApi.passes(projectId as string), enabled: !!projectId, refetchInterval: RUNS_POLL_MS }),
  charter: (projectId: string | undefined, enabled: boolean) =>
    queryOptions({ queryKey: runKeys.charter(projectId), queryFn: () => runsApi.charter(projectId as string), enabled: enabled && !!projectId }),
};
