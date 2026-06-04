// web-v2 feature module: sessions (agent-sessions queue). Types are re-typed
// to match the exact FLAT `agent_sessions` rows returned by
// `packages/core/src/agent-sessions/routes.ts` (verified for ISS-291 — the row
// uses `id`, NOT `documentId`, and carries no per-session dollar cost / model).
// The display-status derivation + status vocabulary are ported from the v1
// `packages/web/src/features/agent/api.ts` so both UIs agree.
import type { StatusKey } from "@/design/status";
import type { StageKey } from "@/design/stages";

/**
 * Real persisted status enum (`agentSessionStatuses` in core schema). The
 * prototype's `done`/`zombie`/`canceled` are NOT real — map them via
 * `statusToChip` below. `completed_via_recovery` / `cancelled_stale` are the
 * non-failure terminal markers written by the recovery-by-verification path
 * (ISS-197).
 */
export type AgentSessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "completed_via_recovery"
  | "cancelled_stale";

/** Synthetic UI-only state derived from heartbeat freshness. The backend only
 *  persists `running`; the `stalled` distinction is presentational. */
export type AgentSessionDisplayStatus = AgentSessionStatus | "stalled";

/** Warning band between a fresh heartbeat and the sweeper's heartbeat_timeout
 *  cutoff — promote `running` → `stalled` past this. */
export const STALLED_THRESHOLD_MS = 60_000;

/**
 * Hard auto-reap bound: the server zombie-sweep fails a `running` session whose
 * heartbeat is older than this. Mirrors core `HEARTBEAT_TIMEOUT_MS_DEFAULT`
 * (`packages/core/src/pipeline/sweeper.ts` = 3 min). The FE constant cannot read
 * the `PIPELINE_HEARTBEAT_TIMEOUT_MS` env override, so an operator who lowers it
 * server-side will see the countdown run slightly long — documented limitation
 * (ISS-378). Past this bound the UI shows `reaping`, not "already reaped".
 */
export const HEARTBEAT_REAP_MS = 3 * 60_000;

/**
 * Heartbeat liveness, single-sourced across the fleet strip, list, and detail
 * (ISS-378 AC#5). `alive` → fresh; `stale` → past the warning threshold but
 * before the server reap (a countdown to auto-recovery is shown); `reaping` →
 * past the reap bound, the server sweep should be acting; `na` → not gradable
 * (terminal/queued sessions, or interactive chat which a headless runner never
 * heartbeats, so it must NOT read as wedged — AC#4).
 */
export type Liveness = "alive" | "stale" | "reaping" | "na";

export interface LivenessResult {
  state: Liveness;
  /** Time since the last heartbeat signal, or null when not gradable. */
  sinceHeartbeatMs: number | null;
  /** Milliseconds until the server auto-reaps (`stale` only); 0 once `reaping`,
   *  null when not gradable. */
  reapInMs: number | null;
}

export type SessionFailureReason =
  | "queue_timeout"
  | "heartbeat_timeout"
  | "no_worker_online"
  | "user_cancelled"
  | "job_failed"
  | "migration_zombie_cleanup"
  | "issue_busy"
  | "waiting_on_dep"
  | "project_full"
  | "runner_full";

/** Usage telemetry jsonb — every key is optional (older rows omit fields). */
export interface SessionUsage {
  turns?: number;
  contextUsed?: number;
  inputTotal?: number;
  outputTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Metadata jsonb — `type` is the session kind (pipeline/pm/agent/interactive),
 *  `step`/`stage` (when present) name the pipeline step driving the session. */
export interface SessionMetadata {
  type?: string;
  issueId?: string;
  deviceId?: string;
  step?: string;
  stage?: string;
  [key: string]: unknown;
}

/** Flat `agent_sessions` row as returned by `GET /api/agent-sessions`. */
export interface SessionRow {
  id: string;
  projectId: string;
  userId: string | null;
  deviceId: string | null;
  pipelineRunId: string | null;
  title: string | null;
  /** Absolute repo checkout path the session ran against (resolved from the
   *  project repoPath). Present on the full row; older rows may be null. */
  repoPath: string | null;
  status: AgentSessionStatus;
  usage: SessionUsage | null;
  metadata: SessionMetadata | null;
  failureReason: SessionFailureReason | string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Full canonical transcript — present on the `GET /:id` detail row only
   *  (the list endpoint omits it). The read-only render fallback when the
   *  per-turn `/turns` table is empty (ISS-348). */
  messages?: unknown[];
  totalMessages?: number;
}

/** `GET /api/agent-sessions/queue-stats` response (per-device counters). */
export interface QueueStats {
  devices: { deviceId: string | null; queued: number; running: number }[];
}

/** `GET /api/agent-sessions/:id/cost` — per-session usage_records rollup
 *  (ISS-378 AC#6). `models` is the per-model spend breakdown, spend-ordered. */
export interface SessionCost {
  sessionId: string;
  projectId: string;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
  models: { model: string; cost: number; requests: number }[];
}

/** Client-side filter tabs. `attention` = failed + stalled + cancelled_stale. */
export type SessionFilter = "all" | "running" | "queued" | "attention";

/** Session kind: `pipeline` (job-driven, picked up by a headless runner) vs
 *  `chat` (interactive desktop session that spawns no job). A `chat` session
 *  sitting `running` is NOT a wedged runner — it is awaiting the user, so the
 *  liveness derivation treats it as `na` (ISS-378 AC#4). */
export function sessionKind(session: Pick<SessionRow, "metadata">): "pipeline" | "chat" {
  const type = session.metadata?.type;
  return type === "pipeline" || type === "pm" ? "pipeline" : "chat";
}

/** Whether a session is an interactive chat (not driven by a pipeline job). */
export function isInteractiveSession(session: Pick<SessionRow, "metadata">): boolean {
  return sessionKind(session) === "chat";
}

/** Operator-facing label for each terminal failure reason — surfaced on the
 *  list row + the detail blocker-card so "failed" is actionable (ISS-378). */
export const FAILURE_REASON_LABEL: Record<string, string> = {
  queue_timeout: "Queue timeout",
  heartbeat_timeout: "No heartbeat",
  no_worker_online: "No runner online",
  user_cancelled: "Cancelled",
  job_failed: "Job failed",
  migration_zombie_cleanup: "Swept (migration)",
  issue_busy: "Issue busy",
  waiting_on_dep: "Waiting on dependency",
  project_full: "Project at capacity",
  runner_full: "Runner at capacity",
};

/** Suggested next action for a failed/stalled session — the one-line remedy on
 *  the detail blocker-card (ISS-378 AC#6). */
export const FAILURE_REASON_ACTION: Record<string, string> = {
  queue_timeout: "No runner picked it up — check the fleet strip for an online runner.",
  heartbeat_timeout: "The runner died mid-run — Retry to re-dispatch.",
  no_worker_online: "Bring a runner online or check device pairing, then Retry.",
  user_cancelled: "Cancelled by a user — Rerun to start a fresh session.",
  job_failed: "The agent step failed — open the run timeline to see why.",
  issue_busy: "Another session holds this issue — it will retry once that frees.",
  waiting_on_dep: "Blocked on a dependency issue — resolve the blocker first.",
  project_full: "Project hit its concurrency cap — it will dispatch when a slot frees.",
  runner_full: "The runner is at capacity — it will dispatch when a slot frees.",
};

/**
 * Single source of truth for heartbeat liveness across the fleet strip, list,
 * and detail (ISS-378 AC#5). Only `running` pipeline sessions are gradable:
 *   since ≤ STALLED_THRESHOLD_MS → alive
 *   since ≤ HEARTBEAT_REAP_MS    → stale (reapInMs counts down to auto-recovery)
 *   else                         → reaping (server sweep should be acting)
 * Interactive chat + non-running sessions return `na`.
 */
export function deriveLiveness(
  session: Pick<
    SessionRow,
    "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata"
  >,
  nowMs: number = Date.now(),
): LivenessResult {
  const naResult: LivenessResult = { state: "na", sinceHeartbeatMs: null, reapInMs: null };
  if (session.status !== "running") return naResult;
  // A headless runner never heartbeats an interactive chat — don't grade it.
  if (isInteractiveSession(session)) return naResult;

  const lastSignal = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
  if (!lastSignal) return { state: "alive", sinceHeartbeatMs: null, reapInMs: null };
  const lastMs = new Date(lastSignal).getTime();
  if (Number.isNaN(lastMs)) return { state: "alive", sinceHeartbeatMs: null, reapInMs: null };

  const since = nowMs - lastMs;
  if (since <= STALLED_THRESHOLD_MS) return { state: "alive", sinceHeartbeatMs: since, reapInMs: null };
  if (since <= HEARTBEAT_REAP_MS) {
    return { state: "stale", sinceHeartbeatMs: since, reapInMs: HEARTBEAT_REAP_MS - since };
  }
  return { state: "reaping", sinceHeartbeatMs: since, reapInMs: 0 };
}

/**
 * Promote `running` → `stalled` past the warning threshold. Reimplemented on top
 * of `deriveLiveness` (ISS-378) so the list/stat/filter vocabulary stays single-
 * sourced: `stale`/`reaping` → `stalled`; `alive`/`na` (incl. interactive chat)
 * → `running`. Non-running sessions pass through their persisted status.
 */
export function deriveSessionDisplayStatus(
  session: Pick<
    SessionRow,
    "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata"
  >,
  nowMs: number = Date.now(),
): AgentSessionDisplayStatus {
  if (session.status !== "running") return session.status;
  const { state } = deriveLiveness(session, nowMs);
  return state === "stale" || state === "reaping" ? "stalled" : "running";
}

/** Map a real/derived session status to a design-kit `StatusKey` for StatusChip. */
export function statusToChip(display: AgentSessionDisplayStatus): StatusKey {
  switch (display) {
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "idle":
      return "paused";
    case "completed":
    case "completed_via_recovery":
      return "done";
    case "failed":
      return "failed";
    case "cancelled_stale":
    case "stalled":
      return "zombie";
    default:
      return "queued";
  }
}

type RunStatus = "running" | "done" | "failed" | "blocked" | "queued" | "review";

/** Map a session status to the mini PipelineTracker's run-status vocabulary. */
export function statusToRun(display: AgentSessionDisplayStatus): RunStatus {
  switch (display) {
    case "running":
      return "running";
    case "completed":
    case "completed_via_recovery":
      return "done";
    case "failed":
      return "failed";
    case "cancelled_stale":
    case "stalled":
      return "blocked";
    case "idle":
    case "queued":
    default:
      return "queued";
  }
}

const STEP_TO_STAGE: Record<string, StageKey> = {
  triage: "triage",
  clarify: "clarify",
  plan: "plan",
  code: "code",
  fix: "code",
  develop: "code",
  development: "code",
  review: "review",
  test: "test",
  testing: "test",
  deploy: "test",
  deploying: "test",
  verify: "test",
  release: "release",
  staging: "release",
};

/**
 * Best-effort pipeline stage for the per-row mini tracker. The row has no clean
 * stage field, so derive from `metadata.step`/`stage`/`type`; default to `code`
 * (the running mini bar sweeps indeterminately, so an exact stage isn't needed).
 */
export function deriveStage(metadata: SessionMetadata | null): StageKey {
  const raw = (metadata?.step || metadata?.stage || metadata?.type || "").toString().toLowerCase();
  for (const [key, stage] of Object.entries(STEP_TO_STAGE)) {
    if (raw.includes(key)) return stage;
  }
  return "code";
}

/** Whether a session can be retried (pipeline/pm sessions tied to an issue). */
export function isRetryable(row: SessionRow): boolean {
  const type = row.metadata?.type;
  return (type === "pipeline" || type === "pm") && !!row.metadata?.issueId;
}
