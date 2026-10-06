"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type StuckRuns, stuckRunsOf } from "@/features/sessions/types";
import { runsApi } from "./api";
import type { RunStandingScope } from "./types";

const RUNS_POLL_MS = 20_000;

/** Every key the runs read model answers under; a write that moves a run invalidates it. */
export const RUNS_STANDING_ROOT = "runs-standing";
export const runsKey = (projectId: string | undefined) => [RUNS_STANDING_ROOT, projectId] as const;

export function useRunStanding(projectId: string | undefined, scope: RunStandingScope) {
  return useQuery({
    queryKey: [...runsKey(projectId), "list", scope],
    queryFn: () => runsApi.standing(projectId as string, scope),
    enabled: !!projectId,
    refetchInterval: RUNS_POLL_MS,
  });
}

export function useRunDetail(projectId: string | undefined, runId: string) {
  return useQuery({
    queryKey: [...runsKey(projectId), "run", runId],
    queryFn: () => runsApi.run(projectId as string, runId),
    enabled: !!projectId && !!runId,
    refetchInterval: RUNS_POLL_MS,
  });
}

export function useMasterStanding(projectId: string | undefined) {
  return useQuery({
    queryKey: [...runsKey(projectId), "master"],
    queryFn: () => runsApi.master(projectId as string),
    enabled: !!projectId,
    refetchInterval: RUNS_POLL_MS,
  });
}

export function useMasterPasses(projectId: string | undefined) {
  return useQuery({
    queryKey: [...runsKey(projectId), "passes"],
    queryFn: () => runsApi.passes(projectId as string),
    enabled: !!projectId,
    refetchInterval: RUNS_POLL_MS,
  });
}

export function useMasterCharter(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...runsKey(projectId), "charter"],
    queryFn: () => runsApi.charter(projectId as string),
    enabled: enabled && !!projectId,
  });
}

/** The runs core reads as stuck on this project (`runs/standing`, live scope), as a lookup a session row is
 *  read against; empty until it loads, so nothing shows stalled on a guess. */
export function useStuckRuns(projectId: string | undefined): StuckRuns {
  const standing = useRunStanding(projectId, "live");
  return useMemo(() => stuckRunsOf(standing.data?.items), [standing.data]);
}
