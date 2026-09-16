// Which pipeline runs on this project have nothing working on them.
//
// `liveJobs` counts a run's queued/dispatched/running JOBS; `agent_sessions`
// hangs off the run and not off a job, so a master-lane run carries a live
// agent and zero jobs. Asking only the first question answers "abandoned" for
// every live master, which is why core carries both facts on the same row.

import type { PipelineRunListItem } from "@/features/pipeline/types";
import { HEARTBEAT_REAP_MS } from "@/features/sessions/types";

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "paused"]);

/** Whether core has heard from a session on this run recently enough to call it alive. */
export function sessionIsBeating(
  run: Pick<PipelineRunListItem, "lastSessionBeatAt">,
  nowMs: number,
): boolean {
  if (!run.lastSessionBeatAt) return false;
  const beat = Date.parse(run.lastSessionBeatAt);
  if (Number.isNaN(beat)) return false;
  return nowMs - beat <= HEARTBEAT_REAP_MS;
}

/** Whether a run that has never been heard from is still inside its startup grace. */
function runIsStartingUp(
  run: Pick<PipelineRunListItem, "lastSessionBeatAt" | "startedAt">,
  nowMs: number,
): boolean {
  if (run.lastSessionBeatAt) return false;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return false;
  return nowMs - started <= HEARTBEAT_REAP_MS;
}

/**
 * Live runs with neither a live job nor a heartbeating session.
 */
export function stalledRuns(
  runs: readonly PipelineRunListItem[] | undefined,
  nowMs: number,
): PipelineRunListItem[] {
  return (runs ?? []).filter(
    (r) =>
      LIVE_RUN_STATUSES.has(r.status) &&
      (r.liveJobs ?? 0) === 0 &&
      !sessionIsBeating(r, nowMs) &&
      !runIsStartingUp(r, nowMs),
  );
}
