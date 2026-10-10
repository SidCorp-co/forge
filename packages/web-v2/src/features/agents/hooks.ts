"use client";

import { useQuery } from "@tanstack/react-query";
import { type StuckRuns, stuckRunsOf } from "@/features/sessions";
import { RUNS_STANDING_ROOT, runKeys, runQueries } from "./queries";
import type { RunStandingScope } from "./types";

export { RUNS_STANDING_ROOT };
export const runsKey = runKeys.project;

export function useRunStanding(projectId: string | undefined, scope: RunStandingScope) {
  return useQuery(runQueries.standing(projectId, scope));
}

export function useRunDetail(projectId: string | undefined, runId: string) {
  return useQuery(runQueries.run(projectId, runId));
}

export function useMasterStanding(projectId: string | undefined) {
  return useQuery(runQueries.master(projectId));
}

export function useMasterPasses(projectId: string | undefined) {
  return useQuery(runQueries.passes(projectId));
}

export function useMasterCharter(projectId: string | undefined, enabled: boolean) {
  return useQuery(runQueries.charter(projectId, enabled));
}

/** The runs core reads as stuck on this project (`runs/standing`, live scope), as a lookup a session row is
 *  read against; empty until it loads, so nothing shows stalled on a guess. */
export function useStuckRuns(projectId: string | undefined): StuckRuns {
  const standing = useRunStanding(projectId, "live");
  return stuckRunsOf(standing.data?.items);
}
