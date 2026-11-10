
import { useQuery } from "@tanstack/react-query";
import { readerZone } from "@/design";
import { type StuckRuns, stuckRunsOf } from "@/features/sessions";
import { liveIssueKeys, projectNowOf } from "./now";
import { nowQueries, RUNS_STANDING_ROOT, runKeys, runQueries } from "./queries";
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

/** How the project's runs move, per day in the reader's zone. */
export function useRunFlow(projectId: string | undefined) {
  return useQuery(runQueries.flow(projectId, readerZone()));
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

/**
 * The issues the project's live bar names, read from the bar's own query (shared, never a second
 * request beside it); empty until it answers, so a page leaves nothing out on a read nobody has made.
 */
export function useLiveIssueKeys(projectId: string): ReadonlySet<string> {
  const live = useQuery(nowQueries.live(projectId));
  if (!live.data) return new Set();
  return liveIssueKeys(projectNowOf({ state: "read", data: live.data }, { state: "loading" }, { state: "loading" }));
}
