
import {
  FAILURE_CAUSE_PRESENTATION,
  type FailureCause,
  LEGACY_NEUTRAL_REASONS,
  resolveFailureCause,
} from "@forge/contracts/failure-causes";
import { TERMINAL_AGENT_SESSION_STATUSES } from "@forge/contracts/status-sets";
import type { StatusKey } from "@/design/status";

export type AgentSessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "completed_via_recovery"
  | "cancelled_stale"
  | "cancelled";

export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set<AgentSessionStatus>(
  TERMINAL_AGENT_SESSION_STATUSES,
);

/** Synthetic UI-only state derived from heartbeat freshness. The backend only
 *  persists `running`; the `stalled` distinction is presentational. */
export type AgentSessionDisplayStatus = AgentSessionStatus | "stalled";

/** Warning band between a fresh heartbeat and the sweeper's heartbeat_timeout
 *  cutoff — promote `running` → `stalled` past this. */
export const STALLED_THRESHOLD_MS = 60_000;

export const HEARTBEAT_REAP_MS = 3 * 60_000;

export type Liveness = "alive" | "stale" | "reaping" | "na";

export interface LivenessResult {
  state: Liveness;
  /** Time since the last heartbeat signal, or null when not gradable. */
  sinceHeartbeatMs: number | null;
  /** Milliseconds until the server auto-reaps (`stale` only); 0 once `reaping`,
   *  null when not gradable. */
  reapInMs: number | null;
}

export type SessionFailureReason = FailureCause | LegacyFailureReason;

export type LegacyFailureReason =
  | "issue_busy"
  | "runner_full"
  | "no_worker_online"
  | "ws-publish-failed"
  | "job_failed";

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
  kind?: AgentSessionKind | null;
  /** The session that owns this one, as core issued it. `null` is a root. */
  parentSessionId?: string | null;
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
  /** Per-session dollar cost rolled up from usage_records, attached by the list
   *  endpoint (ISS-391). 0 when the session has no usage rows yet. */
  estimatedCost?: number;
  /** One-line preview of the last user/assistant turn, attached by the list
   *  endpoint (ISS-698). Null when no previewable turn exists yet (e.g. a
   *  brand-new session, or a legacy row with only the jsonb transcript). */
  lastMessagePreview?: string | null;
}

/** `GET /api/agent-sessions/queue-stats` response (per-device counters). */
export interface QueueStats {
  devices: { deviceId: string | null; queued: number; running: number }[];
}

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

/** Client-side filter tabs. `waiting` = an interactive chat idle after its last
 *  turn (genuinely awaiting the owner's reply — ISS-664). `attention` = failed +
 *  stalled + cancelled_stale (unchanged; job failures, not reply-waiting). */
export type SessionFilter = "all" | "waiting" | "running" | "queued" | "attention";

export type AgentSessionKind = "master" | "run_session" | "pipeline" | "pm" | "chat";

export const AGENT_SESSION_KINDS: AgentSessionKind[] = [
  "master",
  "run_session",
  "pipeline",
  "pm",
  "chat",
];

export const SESSION_KIND_LABEL: Record<AgentSessionKind, string> = {
  master: "Master",
  run_session: "Run",
  pipeline: "Step",
  pm: "PM",
  chat: "Chat",
};

/**
 * The species the row states. A row served by a deployment older than the
 * column falls back to reading `metadata.type`, rather than claiming a species
 * the server never sent.
 */
export function sessionKind(
  session: Pick<SessionRow, "metadata"> & { kind?: AgentSessionKind | null },
): AgentSessionKind {
  if (session.kind && AGENT_SESSION_KINDS.includes(session.kind)) return session.kind;
  const type = session.metadata?.type;
  if (type === "pipeline" || type === "pm" || type === "master" || type === "run_session") {
    return type;
  }
  return "chat";
}

export function isJobDriven(
  session: Pick<SessionRow, "metadata"> & { kind?: AgentSessionKind | null },
): boolean {
  const k = sessionKind(session);
  return k === "pipeline" || k === "pm";
}

/** Whether a session is an interactive chat (not driven by a pipeline job). */
export function isInteractiveSession(
  session: Pick<SessionRow, "metadata"> & { kind?: AgentSessionKind | null },
): boolean {
  return sessionKind(session) === "chat";
}

export function isAwaitingReply(
  session: Pick<SessionRow, "status" | "metadata"> & { kind?: AgentSessionKind | null },
): boolean {
  return isInteractiveSession(session) && session.status === "idle";
}

/** Operator-facing label for each terminal failure reason — surfaced on the
 *  list row + the detail blocker-card so "failed" is actionable (ISS-378). */
export const FAILURE_REASON_LABEL: Record<SessionFailureReason, string> = {
  provider_spend_cap: "Spend limit reached",
  provider_usage_limit: "Usage limit reached",
  provider_subscription_disabled: "Subscription disabled",
  provider_auth_expired: "Sign-in expired",
  provider_overloaded: "Model provider overloaded",
  provider_refused_request: "Request refused",
  agent_startup_failed: "Agent didn't start",
  agent_skill_missing: "Skill missing on runner",
  agent_exited_without_result: "Agent exited with no result",
  agent_killed: "Agent killed",
  workspace_preflight_failed: "Checkout not usable",
  workspace_disk_full: "Runner disk full",
  repo_root_contention: "Runner repo busy",
  box_session_saturated: "Runner at session capacity",
  runner_unreachable: "Runner unreachable",
  duplex_channel_failed: "Session channel failed",
  session_lost: "Session lost",
  ws_publish_failed: "Delivery failed",
  "ws-publish-failed": "Delivery failed",
  forge_budget_exhausted: "Project budget spent",
  runner_unsupported_type: "Runner can't run this step",
  resume_failed: "Resume failed",
  residency_expired: "Session window expired",
  park_unanswered: "Question went unanswered",
  audit_ran_blind: "Ran without evidence",
  orphan_under_terminal_run: "Cleaned up (run ended)",
  pipeline_cancelled: "Pipeline cancelled",
  pipeline_completed: "Cleaned up (run finished)",
  pipeline_failed: "Cleaned up (run failed)",
  manual_ops_stale_chat_schedule: "Cleared by an operator",
  unclassified: "Unclassified",
  queue_timeout: "Queue timeout",
  heartbeat_timeout: "No heartbeat",
  turn_never_reported: "No turn ever reported",
  no_worker_online: "No runner online",
  no_client_ack: "No acknowledgement",
  skill_not_synced: "Skill not ready yet",
  user_cancelled: "Cancelled",
  job_failed: "Unclassified",
  migration_zombie_cleanup: "Swept (migration)",
  issue_busy: "Issue busy",
  runner_full: "Runner at capacity",
};

/** Suggested next action for a failed/stalled session — the one-line remedy on
 *  the detail blocker-card (ISS-378 AC#6). */
export const FAILURE_REASON_ACTION: Record<SessionFailureReason, string> = {
  provider_spend_cap: "The account hit its spend cap — raise it, or wait for the window to reset.",
  provider_usage_limit: "The account hit its usage window — it retries once the window resets.",
  provider_subscription_disabled:
    "Claude Code access is off for this organization — an admin has to turn it back on.",
  provider_auth_expired: "The runner's sign-in expired — re-authenticate it, then Retry.",
  provider_overloaded: "The model provider was busy — Retry.",
  provider_refused_request: "The provider refused the request — check the model and prompt settings.",
  agent_startup_failed: "The agent never got going on this runner — check its MCP config, then Retry.",
  agent_skill_missing: "The skill hasn't reached this runner — sync it, then Retry.",
  agent_exited_without_result: "The agent exited before reporting — Retry to re-dispatch.",
  agent_killed: "Something killed the agent process — check the runner logs.",
  workspace_preflight_failed: "The runner's checkout is unusable — fix the repo path or remote.",
  workspace_disk_full: "The runner is out of disk — free space, then Retry.",
  repo_root_contention:
    "Another job on that runner held the repo for ten minutes — Retry once it is free.",
  box_session_saturated:
    "That runner had no session slot free — the job moves to another box on its own.",
  runner_unreachable: "The runner never picked it up — check it's online, then Retry.",
  duplex_channel_failed: "The session channel dropped — a fresh session is the next step.",
  session_lost: "The session died without reporting — Retry to re-dispatch.",
  ws_publish_failed: "The reply couldn't be delivered — start a new chat to retry.",
  "ws-publish-failed": "The reply couldn't be delivered — start a new chat to retry.",
  forge_budget_exhausted: "This project spent its monthly budget — raise it or wait for the cycle.",
  runner_unsupported_type: "This runner can't run this step — assign a runner that can.",
  resume_failed: "Resuming the previous session failed — Rerun to start fresh.",
  residency_expired: "The session outlived its window — Rerun to start fresh.",
  park_unanswered: "Nobody answered the agent's question before its deadline — the work stopped and its branch was kept.",
  audit_ran_blind: "The scheduled run called no tools, so it produced no evidence — Rerun.",
  unclassified: "The cause wasn't recorded — open the run timeline to see why.",
  queue_timeout: "No runner picked it up — check the fleet strip for an online runner.",
  heartbeat_timeout: "The runner died mid-run — Retry to re-dispatch.",
  turn_never_reported:
    "A runner picked this up but nothing ever reported the agent starting a turn — check whether its prompt was actually submitted, then Rerun.",
  no_worker_online: "Bring a runner online or check device pairing, then Retry.",
  no_client_ack: "The runner never acknowledged the dispatch — Retry to re-send.",
  user_cancelled: "Cancelled by a user — Rerun to start a fresh session.",
  job_failed: "The cause wasn't recorded — open the run timeline to see why.",
  issue_busy: "Another session holds this issue — it will retry once that frees.",
  runner_full: "The runner is at capacity — it will dispatch when a slot frees.",
  skill_not_synced: "The skill hadn't finished syncing to the runner yet — start a new chat to retry.",
  orphan_under_terminal_run: "The run ended while this was still open — nothing to do.",
  pipeline_cancelled: "The pipeline run was cancelled — nothing to do.",
  pipeline_completed: "The run finished while this was still open — nothing to do.",
  pipeline_failed: "The run failed and this was cleaned up with it — see the run timeline.",
  migration_zombie_cleanup: "Swept by a migration — nothing to do.",
  manual_ops_stale_chat_schedule: "An operator cleared this stale session — nothing to do.",
};

/**
 * Look a stored reason up, from a caller that only has a `string`.
 *
 * The maps above are exhaustive over the union so a missing entry is a build
 * error; a caller reading a row off the wire has plain text and must come
 * through here. `resolveFailureCause` is what makes an old spelling land on the
 * right entry instead of the fallback.
 */
export function failureReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return (
    FAILURE_REASON_LABEL[reason as SessionFailureReason] ??
    FAILURE_REASON_LABEL[resolveFailureCause(reason)]
  );
}

export function failureReasonAction(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return (
    FAILURE_REASON_ACTION[reason as SessionFailureReason] ??
    FAILURE_REASON_ACTION[resolveFailureCause(reason)]
  );
}

export function deriveLiveness(
  session: Pick<
    SessionRow,
    "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata"
  >,
  nowMs: number = Date.now(),
): LivenessResult {
  const naResult: LivenessResult = { state: "na", sinceHeartbeatMs: null, reapInMs: null };
  if (session.status !== "running") return naResult;
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
      return "swept";
    case "cancelled":
      return "archived";
    case "stalled":
      return "zombie";
    default:
      return "queued";
  }
}


export type SessionOutcomeBucket = "success" | "failed" | "cleanup" | "swept" | "active";

function presentationOf(reason: string): "cleanup" | "swept" | "failure" {
  if (LEGACY_NEUTRAL_REASONS.has(reason)) return "swept";
  return FAILURE_CAUSE_PRESENTATION[resolveFailureCause(reason)];
}

export interface SessionOutcome {
  bucket: SessionOutcomeBucket;
  /** Design-kit token to colour the chip — `swept`/`done` are neutral/green,
   *  only `failed` is red. */
  statusKey: StatusKey;
  /** Short chip/secondary label. */
  label: string;
  /** Plain-language tooltip explaining why this is (or isn't) a failure. */
  tooltip: string;
}

/**
 * Classify a terminal session into the four ISS-322 buckets from its display
 * status + `failureReason`. Non-terminal states return `active` and defer to
 * `statusToChip`. Keep red strictly for genuine failures.
 */
export function classifySessionOutcome(
  display: AgentSessionDisplayStatus,
  failureReason?: string | null,
): SessionOutcome {
  if (display === "completed" || display === "completed_via_recovery") {
    return { bucket: "success", statusKey: "done", label: "Completed", tooltip: "Finished cleanly." };
  }

  if (display === "cancelled_stale") {
    return {
      bucket: "swept",
      statusKey: "swept",
      label: "Swept (overdue)",
      tooltip:
        "Swept after going stale (no recent heartbeat). This is automatic cleanup, not a failure.",
    };
  }

  if (display === "cancelled") {
    return {
      bucket: "cleanup",
      statusKey: "archived",
      label: "Cancelled",
      tooltip: "Stopped on purpose — not a failure.",
    };
  }

  if (display === "failed") {
    const reason = failureReason ?? null;
    const presentation = reason ? presentationOf(reason) : "failure";
    if (presentation === "cleanup") {
      return {
        bucket: "cleanup",
        statusKey: "swept",
        label: "Cleaned up",
        tooltip:
          "This step was automatically cleaned up when the pipeline finished — not a failure.",
      };
    }
    if (presentation === "swept") {
      return {
        bucket: "swept",
        statusKey: "swept",
        label: failureReasonLabel(reason) ?? "Cancelled",
        tooltip:
          failureReasonAction(reason) ??
          "Cancelled by a lifecycle or capacity rule — not a failure.",
      };
    }
    return {
      bucket: "failed",
      statusKey: "failed",
      label: failureReasonLabel(reason) ?? "Failed",
      tooltip: failureReasonAction(reason) ?? "The agent step failed — see the run timeline.",
    };
  }

  return {
    bucket: "active",
    statusKey: statusToChip(display),
    label: display,
    tooltip: "",
  };
}

/** Whether a terminal session is a genuine failure (the only bucket that should
 *  read red / count toward "attention"). Live `stalled` sessions are handled
 *  separately by the caller (they are not terminal). */
export function isRealFailure(
  display: AgentSessionDisplayStatus,
  failureReason?: string | null,
): boolean {
  return classifySessionOutcome(display, failureReason).bucket === "failed";
}

/** The step this session RECORDED, verbatim — or `null`, for a session that recorded none. */
export function sessionStep(metadata: SessionMetadata | null): string | null {
  for (const value of [metadata?.step, metadata?.stage]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/** Whether a session can be retried (job-driven sessions tied to an issue). */
export function isRetryable(row: SessionRow): boolean {
  return isJobDriven(row) && !!row.metadata?.issueId;
}
