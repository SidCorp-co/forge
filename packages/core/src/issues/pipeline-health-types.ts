import type { PauseResumer } from '@forge/contracts/run-standing';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { IssueWorker, SessionWorkerLane } from './issue-worker.js';
import type { RunnerAvailability } from './ports.js';
import type { LeaseReading } from './session-claim.js';

export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'runner_stale'
  | 'runner_too_old';

export type WaitingCause = WaitingKind;

/** A gate or a pause as a person reads it: what holds the step, who acts, and whether it clears itself. */
export interface PipelineReading {
  short: string;
  detail: string;
  who: string;
  /** False when it clears itself. */
  needsAction: boolean;
}

export interface PipelineGate {
  reason: PipelineWaitingReason;
  since: string;
  details: Record<string, unknown>;
  reading: PipelineReading;
}

export interface PipelineHealth {
  stage: IssueStatus;
  /**
   * ISS-1273 — who is working this issue, on whichever lane opened the work, and `none` with the
   * sentence saying why where no lane can answer. Always present: `stage` alone is a restatement
   * of the status column the caller already had, and an absent field reads as a quiet system.
   */
  worker: IssueWorker;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: PipelineGate;
  queuedAt?: string;
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === 'needs_info'`: what the park is stopped on. */
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
  reading: PipelineReading;
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
  /** The job's payload, which carries a held job's hold bookkeeping (`@forge/contracts/jobs:readHoldState`). */
  payload?: unknown;
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
