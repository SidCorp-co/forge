// How core reads an issue's pipeline to a person: why its next step waits, what holds it, and the
// paused run, mirrored from core's `PipelineHealth`.

import type { NeedsInfoKind } from "@forge/contracts/issue-vocabulary";

/** Why the dispatcher hasn't picked up the issue's next step. Mirrors core
 *  `PipelineWaitingReason` (`issues/pipeline-health.ts`). */
export type WaitingReason =
  | "issue_busy"
  | "job_held"
  | "run_not_running"
  | "retry_cooldown"
  | "runner_stale"
  | "runner_too_old";

/** What a `needs_info` park is stopped on — required by the server at `needs_info`, null elsewhere. */
export type WaitingCause = NeedsInfoKind;

/** ISS-903 — the queued candidate, as core projects it. */
export interface PipelineHealthQueuedStep {
  jobId: string;
  jobType: string;
  stageStatus: string | null;
  queuedAt: string;
  retryAfterAt: string | null;
}

/** Server-derived pipeline health for one issue. Mirrors core `PipelineHealth`
 *  (`issues/pipeline-health.ts:69-79`); `stage` is the single status→stage
 *  projection (do not re-derive a second mapping). */
export interface PipelineHealth {
  stage: string;
  activeSession?: { id: string; status: "queued" | "running"; skill: string };
  waitingOn?: { reason: WaitingReason; since: string; details: Record<string, unknown>; reading: PipelineReading };
  queuedAt?: string;
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === "needs_info"`: what the park is stopped on. */
  waitingCause?: { kind: WaitingCause };
  /** ISS-853 — the issue's paused pipeline run. Present whatever the issue's own
   *  status says and whether or not a step is queued behind it, which is the
   *  whole point: `waitingOn` reaches a pause only through a queued job. */
  pausedRun?: PipelineHealthPausedRun;
}

export type PauseResumer = "operator" | "machine" | "sweeper";

/** A gate or a pause as core reads it to a person: what holds the step, who acts, whether it clears itself. */
export interface PipelineReading {
  short: string;
  detail: string;
  who: string;
  needsAction: boolean;
}

export interface PipelineHealthPausedRun {
  runId: string;
  pauseReason: string | null;
  kind: string | null;
  detail: string | null;
  resumer: PauseResumer;
  since: string;
  reading: PipelineReading;
}
