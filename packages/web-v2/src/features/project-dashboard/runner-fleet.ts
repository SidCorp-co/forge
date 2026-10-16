// The project's runners, read once for the dashboard and the sessions page's box strip (ISS-1228).

import { useNow } from "@/design";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import { useActiveRunners, useProjectRunners } from "@/features/runners/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { type RunnersSummary, runnersSummary } from "./derive";
import { type ReadState, readOf, readOfAll } from "./shape";

export interface RunnerFleet {
  summary: RunnersSummary;
  runners: ReadState;
  /** The queue, active-runner and live-session reads: until all are in, no runner is called busy or free. */
  activity: ReadState;
}

/** A runner hosting a live session is busy; one under a limit ticks each second so its countdown reads true. */
export function useRunnerFleet(projectId: string | undefined, now: number): RunnerFleet {
  const projectRunnersQ = useProjectRunners(projectId ?? null);
  const queueQ = useQueueStats(projectId);
  const activeRunnersQ = useActiveRunners(projectId ?? null);
  const sessionsQ = useSessionsAndHolds(projectId);
  const anyLimited = (projectRunnersQ.data ?? []).some((r) => r.limitReason);
  const tick = useNow(1000, anyLimited);
  const activity = readOfAll(queueQ, activeRunnersQ, sessionsQ);
  const heard = activity.read === "ok";
  return {
    summary: runnersSummary(
      projectRunnersQ.data,
      heard ? queueQ.data : undefined,
      anyLimited ? tick : now,
      heard ? activeRunnersQ.data?.runners : undefined,
      heard ? sessionsQ.data?.sessions : undefined,
    ),
    runners: readOf(projectRunnersQ),
    activity,
  };
}
