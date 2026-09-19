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
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
  pausedRun?: PipelineHealthPausedRun;
}

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
