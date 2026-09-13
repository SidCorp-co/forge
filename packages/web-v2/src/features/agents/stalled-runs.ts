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
// cm:guard freshness is measured on the BEAT and NEVER on a session's `status`: the sweeper fails a silent session on its own schedule, so between a box dying and the sweep there are `running` rows with hours-old heartbeats. Taking those as proof of life is how an abandoned run stays uncounted for as long as the reaper is behind (ISS-998).
export function sessionIsBeating(
  run: Pick<PipelineRunListItem, "lastSessionBeatAt">,
  nowMs: number,
): boolean {
  if (!run.lastSessionBeatAt) return false;
  const beat = Date.parse(run.lastSessionBeatAt);
  if (Number.isNaN(beat)) return false;
  return nowMs - beat <= HEARTBEAT_REAP_MS;
}

/**
 * Live runs with neither a live job nor a heartbeating session.
 */
// cm:guard BOTH halves, and the second is not optional: core's own guard on `liveJobs` (packages/core/src/pipeline/runs-rollup.ts) tells every caller to confirm against the session heartbeat before calling a run dead, and this is that confirmation. Measured on beta 2026-09-13: of the 6 non-terminal runs reading `liveJobs: 0`, all 6 were master-lane runs with a live heartbeat, and the 5 genuine orphans read `liveJobs: 1`.
// cm:guard both facts come off the SAME row, which is the whole reason `lastSessionBeatAt` exists: this used to join a second, paged read of `agent_sessions`, and an offset walk over a set that moves cannot return a consistent snapshot — a session ending between two pages takes a still-running one off the end of the list with it, and its run then reads abandoned (ISS-998).
// cm:edge contract -> packages/web-v2/src/features/project-dashboard/derive.ts — `idleRuns` there is the JOB-liveness bucket and answers a different question; its own guard forbids calling that bucket idle in user-facing copy. This predicate is the one a reader may act on, and the two must not be collapsed.
export function stalledRuns(
  runs: readonly PipelineRunListItem[] | undefined,
  nowMs: number,
): PipelineRunListItem[] {
  return (runs ?? []).filter(
    (r) =>
      LIVE_RUN_STATUSES.has(r.status) && (r.liveJobs ?? 0) === 0 && !sessionIsBeating(r, nowMs),
  );
}
