import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { RunnerAvailability } from '../jobs/queued-gates.js';
import type { PauseResumer } from '../pipeline/run-pause.js';
import type { LeaseReading } from '../pipeline/session-claim.js';
import type { IssueWorker, SessionWorkerLane } from './issue-worker.js';

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
  /**
   * ISS-1273 — who is working this issue, on whichever lane opened the work, and `none` with the
   * sentence saying why where no lane can answer. Always present: `stage` alone is a restatement
   * of the status column the caller already had, and an absent field reads as a quiet system.
   */
  worker: IssueWorker;
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
  /** ISS-1273 — which bind found this row: the metadata key, or the run's issue lease. */
  lane: SessionWorkerLane;
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
  /** ISS-1273 — the issue's own claim, read by `pipeline/lease-fanout.ts`. `null` where the
   *  caller did not read one, which is not the same as a row carrying none. */
  claim?: LeaseReading | null;
  /** Injectable clock for the retry-cooldown comparison; defaults to now. */
  now?: Date;
}
