// web-v2 feature module: pipeline (kanban + run detail + ops monitor). Types
// are re-typed to match the EXACT JSON the core routes return (dates are ISO
// strings over the wire, not `Date`). Pipeline-run shapes are NOT in
// `@forge/contracts` — they live inline in
// `packages/core/src/pipeline/runs-rollup.ts` + `db/schema.ts`; the field names
// here mirror those verbatim (verified for ISS-295). The enum value arrays are
// defined locally (mirroring `db/schema.ts`) so the UI never imports core's
// runtime arrays.

/** `pipelineRunStatuses` — mirrors `db/schema.ts`. */
export const PIPELINE_RUN_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/** `pipelineRunKinds` — mirrors `db/schema.ts`. */
export const PIPELINE_RUN_KINDS = ["issue", "pm", "interactive", "system"] as const;
export type PipelineRunKind = (typeof PIPELINE_RUN_KINDS)[number];

/** `jobTypes` — mirrors `db/schema.ts`. A run's `currentStep` / a step's
 *  `jobType` is one of these. */
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
] as const;
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

/** Per-step status precedence computed by the read-side rollup. */
export type PipelineStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** Aggregate cost rollup for a run (run-level only — steps carry no per-step
 *  cost on the summary). */
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
  failureReason: string | null;
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
  kind: PipelineRunKind;
  status: PipelineRunStatus;
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: PipelineRunStepSummary[];
  cost: PipelineRunCostSummary;
  /** ISS-411 — per-attempt device/retry timeline. */
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
}

/** `GET /api/projects/:id/pipeline-runs` list row — the summary minus the heavy
 *  per-step + per-attempt rollups (the list endpoint omits them). */
export type PipelineRunListItem = Omit<
  PipelineRunSummary,
  "steps" | "attempts" | "retrySummary"
>;

/**
 * Minimal issue row this feature consumes for the kanban cards, from
 * `GET /api/projects/:id/issues/search?withAgentSessions=true`. Only the fields
 * the board renders are typed (the search serializer returns more).
 */
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
  metadata?: ({ branchConfig?: { branch?: string } | null } & Record<string, unknown>) | null;
}

/**
 * One row of `GET /api/pipeline/step-durations` — sourced from the
 * `pipeline_run_step_durations` view. `issueId` is null for pm/interactive/
 * system runs. Capped server-side at 1000 rows.
 */
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
