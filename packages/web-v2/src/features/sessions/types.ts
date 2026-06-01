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

/** Client-side filter tabs. `attention` = failed + stalled + cancelled_stale. */
export type SessionFilter = "all" | "running" | "queued" | "attention";

/**
 * Promote `running` → `stalled` when no heartbeat for STALLED_THRESHOLD_MS.
 * Ported from the v1 agent api so both clients render the same warning band.
 */
export function deriveSessionDisplayStatus(
  session: Pick<SessionRow, "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt">,
  nowMs: number = Date.now(),
): AgentSessionDisplayStatus {
  if (session.status !== "running") return session.status;
  const lastSignal = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
  if (!lastSignal) return "running";
  const lastMs = new Date(lastSignal).getTime();
  if (Number.isNaN(lastMs)) return "running";
  return nowMs - lastMs > STALLED_THRESHOLD_MS ? "stalled" : "running";
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
