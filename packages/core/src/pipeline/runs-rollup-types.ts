// The shapes a pipeline run summary and list item answer.

import { type PipelineRunKind, type PipelineRunStatus } from '../db/schema.js';
import { type RunGateReading } from './ports.js';
import {
  type PipelineRunGroup,
  type PipelineRunLane,
  type PipelineRunStep,
  type ResidentMaster,
} from './runs-lane.js';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface PipelineRunStepSummary {
  jobType: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  agentSessionId: string | null;
}

export interface PipelineRunCostSummary {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

/**
 * ISS-411 — one job row of a run's per-attempt timeline. Unlike `steps`
 * (one row per `jobType`, derived from `agent_sessions`), this is sourced from
 * the `jobs` table so the `retry_of` chain, the device each attempt landed on,
 * and the ISS-407 round-robin state (`payload._autoRetry`) are all visible.
 */
export interface PipelineRunAttempt {
  jobId: string;
  jobType: string;
  status: string;
  /** `jobs.attempts` — re-dispatch counter on this job row. */
  attempts: number;
  /** Prior job in the `retry_of` chain, if this row is a retry. */
  retryOf: string | null;
  deviceId: string | null;
  /** Friendly device name (`devices.name`), null when the device is gone. */
  deviceName: string | null;
  failureReason: string | null;
  /** ISS-877 cause token off the linked `agent_sessions` row; null when the
   *  attempt never reached a session, or died before one was classified. */
  failureCause: string | null;
  /** ISS-877 operator sentence that goes with the cause. */
  failureDetail: string | null;
  /** Retry-policy axis off the job row — a runner that went offline (`infra`)
   *  is not the same failure as a step that broke the build (`code`). */
  failureKind: 'code' | 'infra' | 'transient-cc' | 'timeout' | null;
  /** What the retry engine did with this failure. */
  failureAction: 'terminal' | 'quarantine' | 'failover' | 'retry' | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** ISS-407 round-robin rotation state at the time this row was (re)queued. */
  autoRetry: { round: number; target: string | null; tries: number; done: string[] } | null;
}

/**
 * ISS-411 — derived round-robin headline for the run, taken from the most
 * recent attempt's `_autoRetry`. `round N / maxRounds` + the device the next
 * attempt targets (resolved to a name) make "retried 3x on dev1, now round 2
 * targeting ubuntu5" legible at a glance.
 */
export interface PipelineRunRetrySummary {
  totalAttempts: number;
  round: number;
  maxRounds: number;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
}

export interface PipelineRunSummary {
  id: string;
  projectId: string;
  issueId: string | null;
  lane: PipelineRunLane;
  step: PipelineRunStep;
  /** ISS-1273 — where the group came from and, where there is none, why. `runIssues` IS
   *  `group.issues`, as `currentStep` is `step.step`. */
  group: PipelineRunGroup;
  /** ISS-1273 — the canonical keys this run was opened over; empty off the run-session lane. */
  runIssues: string[];
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for pm/system/interactive runs. */
  issueRef: string | null;
  /** ISS-460 — title of the run's issue; null when the run has no issue. */
  issueTitle: string | null;
  kind: PipelineRunKind;
  status: PipelineRunStatus;
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: PipelineRunStepSummary[];
  cost: PipelineRunCostSummary;
  /**
   * ISS-789 — jobs on this run that are not yet terminal (`queued`,
   * `dispatched`, `running`).
   */
  liveJobs: number;
  /**
   * ISS-998 — the newest heartbeat of any non-terminal `agent_sessions` row on
   * this run, or `null` where the run has none.
   */
  lastSessionBeatAt: string | null;
  /** ISS-1335 — the live master session on a `master`-lane run; `null` off that lane, and on a
   *  master run nothing holds any more. A session of another kind never fills it. */
  residentMaster: ResidentMaster | null;
  /** ISS-411 — per-attempt device/retry timeline (jobs-sourced). */
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
  /** ISS-1192 — the box's declaration gate when this run opened; `null` where
   *  the box reported none. The list row omits it: it carries a breakdown. */
  gateAtOpen: RunGateReading | null;
}

export type PipelineRunListItem = Omit<
  PipelineRunSummary,
  'steps' | 'attempts' | 'retrySummary' | 'gateAtOpen'
>;
