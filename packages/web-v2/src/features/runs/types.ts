
import {
  type REGISTRY_JOB_TYPES,
  REGISTRY_PIPELINE_RUN_KINDS,
  REGISTRY_PIPELINE_RUN_STATUSES,
} from "@forge/contracts/pipeline-registry";

export const PIPELINE_RUN_STATUSES = REGISTRY_PIPELINE_RUN_STATUSES;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

export const PIPELINE_RUN_KINDS = REGISTRY_PIPELINE_RUN_KINDS;
export type PipelineRunKind = (typeof PIPELINE_RUN_KINDS)[number];

export const PIPELINE_JOB_TYPES = [
  "custom",
  "pm",
  "smoke",
  "release_batch",
] as const satisfies readonly (typeof REGISTRY_JOB_TYPES)[number][];
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

export type PipelineStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PipelineRunCostSummary {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

export interface PipelineRunStepSummary {
  jobType: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  agentSessionId: string | null;
}

/** One job row of a run's per-attempt timeline: the `retry_of` chain, its device and its rotation. */
export type RunReading = "running" | "starting" | "waiting" | "queued";

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
  /** When core sent the job to a box, which is not when anything ran. */
  startedAt: string | null;
  /** When the attempt's own session first reported its agent working; null where it never did. */
  ranAt: string | null;
  finishedAt: string | null;
  autoRetry: { round: number; target: string | null; tries: number; done: string[] } | null;
  takenBy: { deviceId: string; deviceName: string | null } | null;
}

export interface PipelineRunRetrySummary {
  totalAttempts: number;
  round: number;
  maxRounds: number;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
}

/** Core `pipeline/runs-lane.ts`: `laneOf` and `groupOf`. */
export type PipelineRunLane = "job" | "run_session" | "master" | "system";

export type PipelineRunGroup =
  | { source: "run_group" | "statuses_at_open"; issues: string[]; detail: null }
  | { source: "none"; issues: []; detail: string };

/** `GET /api/pipeline-runs/:id` — the full run rollup (steps + cost + attempts). */
export interface PipelineRunSummary {
  id: string;
  projectId: string;
  issueId: string | null;
  lane: PipelineRunLane;
  group: PipelineRunGroup;
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for pm/system runs. */
  issueRef: string | null;
  issueTitle: string | null;
  groupTitles?: Record<string, string>;
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
  /** What core says the run's agent is doing (`runs-liveness.ts`), the one word every surface shows. */
  reading: RunReading | null;
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

export interface RunGateCondition {
  verdict: "clear" | "marked" | "failing_open";
  count: number;
  perDay: number | null;
  windowMs: number | null;
  byReason: Array<{ reason: string; count: number }>;
}

/** `GET /api/projects/:id/pipeline-runs` list row: the summary without its step, attempt and gate rollups. */
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

/** One `GET /api/pipeline/throughput` row: issues shipped on one UTC date, a day with none at 0. */
export interface ThroughputRow {
  projectId: string;
  date: string;
  count: number;
}

export interface ProjectRunsOpts {
  projectId: string;
  status?: PipelineRunStatus;
  issueId?: string;
  limit?: number;
  offset?: number;
}

export interface AnalyticsOpts {
  days?: number;
  projectId?: string;
  step?: PipelineJobType;
}
