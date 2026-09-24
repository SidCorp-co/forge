
import type { PipelineHealth } from "@/features/issues/types";
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
  "triage",
  "clarify",
  "plan",
  "code",
  "review",
  "test",
  "release",
  "fix",
  "custom",
  "pm",
  "smoke",
  "release_batch",
] as const satisfies readonly (typeof REGISTRY_JOB_TYPES)[number][];
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

/** Per-step status precedence computed by the read-side rollup. */
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
 *  `retry_of` chain + device + ISS-407 `_autoRetry` rotation are visible). */
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
  autoRetry: { round: number; target: string | null; tries: number; done: string[] } | null;
}

/** ISS-411 — round-robin headline derived from the latest attempt. */
export interface PipelineRunRetrySummary {
  totalAttempts: number;
  round: number;
  maxRounds: number;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
}

/** `GET /api/pipeline-runs/:id` — the full run rollup (steps + cost + attempts). */
export interface PipelineRunSummary {
  id: string;
  projectId: string;
  issueId: string | null;
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for pm/system runs. */
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
export interface RunGateCondition {
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

export interface PipelineIssueRow {
  id: string;
  projectId: string;
  displayId: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  /** Derived by the search hydrator with `?withAgentSessions=true`. */
  agentStatus?: "running" | "queued" | "completed" | "failed" | null;
  /** Whether anything is on the issue now, from the same hydrator — the lane reads "Running" only
   *  where this is true and "No check-in" where it is not (ISS-1213). */
  held: boolean;
  /** When anything last spoke for the issue, from the same hydrator; `null` where core has no time. */
  lastCheckInAt: string | null;
  pipelineHealth?: PipelineHealth;
  metadata?: ({ branchConfig?: { branch?: string } | null } & Record<string, unknown>) | null;
}

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

/** One row of `GET /api/pipeline/throughput` — daily closed/released count. */
export interface ThroughputRow {
  projectId: string;
  date: string;
  count: number;
}

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done";

/** One subtask from `GET /api/issues/:id/tasks` (mirrors `tasks` in
 *  `db/schema.ts`). Used by the RunDetail Tasks tab. */
export interface TaskRow {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  assigneeId: string | null;
  isAgentTask: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
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

export const BOARD_EXCLUDED_STATUSES = ["draft", "closed"] as const;
