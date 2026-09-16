/**
 * ISS-164 — the wire shapes of `pipelineHealth`.
 *
 * Split from `pipeline-health.ts` so its two halves — the loader/classifier and
 * the per-gate reason builders in `pipeline-health-reasons.ts` — can both name
 * these without importing each other. Declarations only; no db, no logic.
 * `pipeline-health.ts` re-exports every name here, which is the path consumers
 * import from.
 */

import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { RunnerAvailability } from '../jobs/queued-gates.js';
import type { PauseResumer } from '../pipeline/run-pause.js';

export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'runner_stale'
  | 'runner_too_old';

/**
 * Why an issue is at `status='waiting'` — AUTHORED by whoever parked it, never
 * derived. Both values mean "a human is needed"; they differ in what the human
 * has to supply.
 */
export type WaitingCause = WaitingKind;

export interface PipelineHealth {
  stage: IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  /** ISS-903 — the identity of the step the oldest queued job represents, set
   *  whenever the issue HAS a queued job, gated or not. `waitingOn` says why it
   *  has not dispatched; this says what has not dispatched. */
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
  /** ISS-853 — the issue's paused pipeline run, whatever the issue's own status
   *  says and whether or not a step is queued behind it. */
  pausedRun?: PipelineHealthPausedRun;
}

/** ISS-853 — the paused parent run, projected for a human surface. `waitingOn`
 *  answers why a queued STEP has not dispatched; this answers why the RUN is
 *  not running, which is a question an issue with no queued step still has. */
export interface PipelineHealthPausedRun {
  runId: string;
  /** `metadata.pauseReason` verbatim; null is an operator pause. */
  pauseReason: string | null;
  /** The kind half of `<kind>:<detail>`; null for an operator pause. */
  kind: string | null;
  /** The detail half — the stage, for `stage_stalled:<stage>`. */
  detail: string | null;
  /** Who ends this pause, from `run-pause.ts#describePause`. */
  resumer: PauseResumer;
  /** `pipeline_runs.updated_at` — when the row last moved, which for a paused
   *  run is the pause itself unless something else has written to it since. */
  since: string;
}

/** ISS-903 — the queued candidate, projected for a human surface. */
export interface PipelineHealthQueuedStep {
  jobId: string;
  jobType: string;
  /** `payload.stageStatus` — null for jobs nobody declared a trigger for. */
  stageStatus: string | null;
  queuedAt: string;
  /** `jobs.retry_after_at` — the next attempt time, when the step has one. */
  retryAfterAt: string | null;
}

export interface PipelineHealthSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface PipelineHealthJob {
  id: string;
  type: string;
  status: string;
  queuedAt: Date;
  runnerId: string | null;
  agentSessionId: string | null;
  /** The hold reason when `status === 'held'` (`jobs/hold.ts`). */
  failureReason?: string | null;
  /** Parent `pipeline_runs.status`. The picker requires `running`. */
  pipelineRunStatus?: string | null;
  /** `payload.stageStatus` — the trigger status the enqueuer declared this job
   *  answers. Null for jobs nobody declared one for (pm, custom). */
  stageStatus?: string | null;
  /** `jobs.retry_after_at` — the picker's L1 cooldown gate outranks the
   *  staleness arm, so a job inside the fixed inter-attempt wait is not
   *  reported stale however stale it is. */
  retryAfterAt?: Date | null;
}

export interface ClassifyInput {
  issue: { id: string; status: string; mergedAt: Date | null; waitingKind: WaitingKind | null };
  sessions: PipelineHealthSession[];
  jobs: PipelineHealthJob[];
  /** From `freshRunnerAvailability` — the picker's own runner-pool counts. */
  runnerPool: RunnerAvailability;
  /** ISS-853 — the issue's paused pipeline run, from `loadPausedRunsByIssue`. */
  pausedRun?: PipelineHealthPausedRun;
  /** Injectable clock for the retry-cooldown comparison; defaults to now. */
  now?: Date;
}
