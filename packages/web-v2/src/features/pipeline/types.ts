
import {
  type REGISTRY_JOB_TYPES,
  REGISTRY_PIPELINE_RUN_KINDS,
} from "@forge/contracts/pipeline-registry";
import { PIPELINE_RUN_STATUSES, type PipelineRunStatus } from "@forge/contracts/run-machine";

export { PIPELINE_RUN_STATUSES, type PipelineRunStatus };

export type PipelineRunKind = (typeof REGISTRY_PIPELINE_RUN_KINDS)[number];

/** Names every job type must take from the registry; one the registry lacks fails to compile. */
type FromRegistry<T extends (typeof REGISTRY_JOB_TYPES)[number]> = T;
type PipelineJobType = FromRegistry<
  "triage"
  | "clarify"
  | "plan"
  | "code"
  | "review"
  | "test"
  | "release"
  | "fix"
  | "custom"
  | "smoke"
  | "release_batch"
>;

/** Per-step status precedence computed by the read-side rollup. */
type PipelineStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

interface PipelineRunCostSummary {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

/** One step (one `jobType`) of a run's timeline. */
export interface PipelineRunStepSummary {
  jobType: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  agentSessionId: string | null;
}

/** ISS-411 — one job row of a run's per-attempt timeline (jobs-sourced, so the
 *  `retry_of` chain, the device and the `_autoRetry` budget are visible). */
export interface PipelineRunAttempt {
  jobId: string;
  jobType: string;
  status: string;
  attempts: number;
  retryOf: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** The classifier's free-text sentence off the job row — jargon, and the same
   *  string for whole families of deaths. Read `failureCause` first. */
  failureReason: string | null;
  /** ISS-877 cause token, joined from the attempt's `agent_sessions` row.
   *  `failureReasonLabel` in `features/sessions/types` turns it into English. */
  failureCause: string | null;
  /** ISS-877 operator sentence for that cause. */
  failureDetail: string | null;
  failureKind: "code" | "infra" | "transient-cc" | "timeout" | null;
  failureAction: "terminal" | "quarantine" | "failover" | "retry" | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  maxAttempts: number | null;
}

/** The run's retry headline, from the latest retry: `attempt N / maxAttempts`. */
export interface PipelineRunRetrySummary {
  totalAttempts: number;
  attempt: number;
  maxAttempts: number;
}

/** `GET /api/pipeline-runs/:id` — the full run rollup (steps + cost + attempts). */
export interface PipelineRunSummary {
  id: string;
  projectId: string;
  issueId: string | null;
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for system and interactive runs. */
  issueRef: string | null;
  /** ISS-460 — title of the run's issue; null when the run has no issue. */
  issueTitle: string | null;
  /** The status of the run's issue now; null when the run has no issue. */
  issueStatus: string | null;
  kind: PipelineRunKind;
  status: PipelineRunStatus;
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: PipelineRunStepSummary[];
  cost: PipelineRunCostSummary;
  /** ISS-789 — jobs on this run not yet terminal. A `running` run with 0 has
   *  nothing working on it; status alone cannot tell that apart. */
  liveJobs: number;
  /** ISS-998 — newest heartbeat of a non-terminal session on this run, or null. */
  lastSessionBeatAt: string | null;
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
  /** ISS-1192 — the box's declaration gate when this run opened; null where the
   *  box reported none, and `unreadable` where core holds one it cannot read. */
  gateAtOpen: RunGate | null;
}

/** ISS-1192 — the run's own record of the gate, as core reads it back. */
export type RunGate =
  | { read: "ok"; condition: RunGateCondition }
  | { read: "unreadable"; reason: string };

/** What a box said about its own declaration gate, as the run holds it. */
interface RunGateCondition {
  verdict: "clear" | "marked" | "failing_open";
  count: number;
  perDay: number | null;
  windowMs: number | null;
  byReason: Array<{ reason: string; count: number }>;
}

/** `GET /api/projects/:id/pipeline-runs` list row — the summary minus the heavy
 *  per-step + per-attempt rollups and the gate (the list endpoint omits them). */
export type PipelineRunListItem = Omit<
  PipelineRunSummary,
  "steps" | "attempts" | "retrySummary" | "gateAtOpen"
>;

export interface StepDurationRow {
  runId: string;
  issueId: string | null;
  projectId: string;
  step: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  costUsd: number;
}

/** Options for the per-project runs list. */
export interface ProjectRunsOpts {
  projectId: string;
  status?: PipelineRunStatus;
  issueId?: string;
  limit?: number;
  offset?: number;
}

/** Options for the cross-project analytics queries. */
export interface AnalyticsOpts {
  days?: number;
  projectId?: string;
  step?: PipelineJobType;
}
