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

// cm:edge contract -> packages/core/src/pipeline/failure-causes.ts — core writes these strings into `agent_sessions.failure_reason`; a cause added there without a label and an action below renders an operator a raw snake_case token
export type SessionFailureReason =
  | "provider_spend_cap"
  | "provider_usage_limit"
  | "provider_subscription_disabled"
  | "provider_auth_expired"
  | "provider_overloaded"
  | "provider_refused_request"
  | "agent_startup_failed"
  | "agent_skill_missing"
  | "agent_exited_without_result"
  | "agent_killed"
  | "workspace_preflight_failed"
  | "workspace_disk_full"
  | "runner_unreachable"
  | "duplex_channel_failed"
  | "session_lost"
  | "ws_publish_failed"
  | "forge_budget_exhausted"
  | "runner_unsupported_type"
  | "resume_failed"
  | "residency_expired"
  | "audit_ran_blind"
  | "orphan_under_terminal_run"
  | "pipeline_cancelled"
  | "pipeline_completed"
  | "pipeline_failed"
  | "manual_ops_stale_chat_schedule"
  | "unclassified"
  | "queue_timeout"
  | "heartbeat_timeout"
  | "no_worker_online"
  | "user_cancelled"
  | "migration_zombie_cleanup"
  // cm:guard dispatcher skip reasons, surfaced on a QUEUED row and never written to `failure_reason` — ISS-162 made them stateless, so treating one as a stored terminal cause resurrects gate state that goes stale the moment the condition clears
  | "issue_busy"
  | "waiting_on_dep"
  | "project_full"
  | "runner_full"
  // ISS-733 fix — a chat-runs-skill cold start (e.g. Build Project Brain) fired
  // before the skill finished syncing to the runner; the CLI treated the
  // slash-command as unknown text. Real failure (red), not a benign cleanup.
  | "skill_not_synced"
  // cm:guard retired by ISS-877, kept because 1,787 live rows still carry it, and it must render as "Unclassified" — it stood for every agent-side failure at once, so showing it as a diagnosis is the lie the taxonomy replaced
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

/** Client-side filter tabs. `waiting` = an interactive chat idle after its last
 *  turn (genuinely awaiting the owner's reply — ISS-664). `attention` = failed +
 *  stalled + cancelled_stale (unchanged; job failures, not reply-waiting). */
export type SessionFilter = "all" | "waiting" | "running" | "queued" | "attention";

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

/**
 * "Waiting for me" (ISS-664): an interactive chat whose agent turn finished
 * (`status:'idle'`, set on interactive turn completion) — the owner has not
 * replied yet. Deliberately EXCLUDES pipeline sessions: a pipeline `queued` (or
 * `idle` while blocked on capacity/deps) is waiting for a RUNNER, not the owner,
 * and must stay in its existing Queued/Attention bucket, not this one.
 */
export function isAwaitingReply(session: Pick<SessionRow, "status" | "metadata">): boolean {
  return isInteractiveSession(session) && session.status === "idle";
}

/** Operator-facing label for each terminal failure reason — surfaced on the
 *  list row + the detail blocker-card so "failed" is actionable (ISS-378). */
export const FAILURE_REASON_LABEL: Record<string, string> = {
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
  runner_unreachable: "Runner unreachable",
  duplex_channel_failed: "Session channel failed",
  session_lost: "Session lost",
  ws_publish_failed: "Delivery failed",
  "ws-publish-failed": "Delivery failed",
  forge_budget_exhausted: "Project budget spent",
  runner_unsupported_type: "Runner can't run this step",
  resume_failed: "Resume failed",
  residency_expired: "Session window expired",
  audit_ran_blind: "Ran without evidence",
  orphan_under_terminal_run: "Cleaned up (run ended)",
  pipeline_cancelled: "Pipeline cancelled",
  pipeline_completed: "Cleaned up (run finished)",
  pipeline_failed: "Cleaned up (run failed)",
  manual_ops_stale_chat_schedule: "Cleared by an operator",
  unclassified: "Unclassified",
  queue_timeout: "Queue timeout",
  heartbeat_timeout: "No heartbeat",
  no_worker_online: "No runner online",
  user_cancelled: "Cancelled",
  job_failed: "Unclassified",
  migration_zombie_cleanup: "Swept (migration)",
  issue_busy: "Issue busy",
  waiting_on_dep: "Waiting on dependency",
  project_full: "Project at capacity",
  runner_full: "Runner at capacity",
  skill_not_synced: "Skill not ready yet",
};

/** Suggested next action for a failed/stalled session — the one-line remedy on
 *  the detail blocker-card (ISS-378 AC#6). */
export const FAILURE_REASON_ACTION: Record<string, string> = {
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
  runner_unreachable: "The runner never picked it up — check it's online, then Retry.",
  duplex_channel_failed: "The session channel dropped — a fresh session is the next step.",
  session_lost: "The session died without reporting — Retry to re-dispatch.",
  ws_publish_failed: "The reply couldn't be delivered — start a new chat to retry.",
  "ws-publish-failed": "The reply couldn't be delivered — start a new chat to retry.",
  forge_budget_exhausted: "This project spent its monthly budget — raise it or wait for the cycle.",
  runner_unsupported_type: "This runner can't run this step — assign a runner that can.",
  resume_failed: "Resuming the previous session failed — Rerun to start fresh.",
  residency_expired: "The session outlived its window — Rerun to start fresh.",
  audit_ran_blind: "The scheduled run called no tools, so it produced no evidence — Rerun.",
  unclassified: "The cause wasn't recorded — open the run timeline to see why.",
  queue_timeout: "No runner picked it up — check the fleet strip for an online runner.",
  heartbeat_timeout: "The runner died mid-run — Retry to re-dispatch.",
  no_worker_online: "Bring a runner online or check device pairing, then Retry.",
  user_cancelled: "Cancelled by a user — Rerun to start a fresh session.",
  job_failed: "The cause wasn't recorded — open the run timeline to see why.",
  issue_busy: "Another session holds this issue — it will retry once that frees.",
  waiting_on_dep: "Blocked on a dependency issue — resolve the blocker first.",
  project_full: "Project hit its concurrency cap — it will dispatch when a slot frees.",
  runner_full: "The runner is at capacity — it will dispatch when a slot frees.",
  skill_not_synced: "The skill hadn't finished syncing to the runner yet — start a new chat to retry.",
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

/** Map a real/derived session status to a design-kit `StatusKey` for StatusChip.
 *  ISS-322: `cancelled_stale` (a terminal session reaped by the stale-sweep) is
 *  a benign cleanup, not a failure — it gets the neutral `swept` token, NOT the
 *  red `zombie` token. `stalled` (a LIVE session whose heartbeat is overdue and
 *  is about to be auto-recovered) stays `zombie`: it is genuinely attention-
 *  worthy. For terminal `failed` rows, prefer `classifySessionOutcome` (it can
 *  see `failureReason` and demote lifecycle/capacity cancels to neutral). */
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
    case "stalled":
      return "zombie";
    default:
      return "queued";
  }
}

// ─── ISS-322: benign-cleanup vs real-failure classifier ─────────────────────

/**
 * Four-bucket outcome for a terminal session, so the UI never paints a benign
 * cleanup or a lifecycle/capacity cancel the same red as a genuine failure:
 *   - `success` — finished cleanly (incl. recovery-verified).
 *   - `failed`  — a REAL failure that needs attention (red). Only `job_failed`
 *                 or an unknown reason on a `failed` row qualifies.
 *   - `cleanup` — auto-cleaned when the pipeline closed (ISS-258 cascade). Most
 *                 such sessions are already `completed` post-ISS-352; this is the
 *                 safety net for legacy rows / non-failure markers.
 *   - `swept`   — swept after going stale, or cancelled by lifecycle/capacity
 *                 (no runner, queue timeout, user cancel, …). Neutral, not red.
 *   - `active`  — not terminal (running/queued/idle/stalled); falls back to the
 *                 plain `statusToChip` mapping.
 */
export type SessionOutcomeBucket = "success" | "failed" | "cleanup" | "swept" | "active";

/** `failureReason`s that mark a benign pipeline cleanup (ISS-258 cascade). The
 *  `pipeline_*` values are the `jobs`-table vocab — defensive: post-ISS-352 the
 *  session itself is `completed`, but a legacy row may still carry them. */
const CLEANUP_REASONS = new Set<string>([
  "migration_zombie_cleanup",
  "pipeline_completed",
  "pipeline_failed",
  "pipeline_cancelled",
  // cm:why ISS-877 — the I1 trigger's marker and an operator's manual clear are the same shape: something ended the run around a session that was still alive, which is cleanup rather than a fault
  "orphan_under_terminal_run",
  "manual_ops_stale_chat_schedule",
]);

/** `failureReason`s that are a lifecycle/capacity cancel or a stale sweep — NOT
 *  a code failure, so they read neutral (`swept`) rather than red. */
const SWEEP_OR_CANCEL_REASONS = new Set<string>([
  "queue_timeout",
  "heartbeat_timeout",
  "no_worker_online",
  "user_cancelled",
  "issue_busy",
  "waiting_on_dep",
  "project_full",
  "runner_full",
  // cm:guard ISS-877 — the residency window closing is a lifecycle bound, not a fault; it is the ONLY taxonomy cause that belongs in this set, because every other member names something that actually went wrong and must stay red
  "residency_expired",
]);

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

  if (display === "failed") {
    const reason = failureReason ?? null;
    if (reason && CLEANUP_REASONS.has(reason)) {
      return {
        bucket: "cleanup",
        statusKey: "swept",
        label: "Cleaned up",
        tooltip:
          "This step was automatically cleaned up when the pipeline finished — not a failure.",
      };
    }
    if (reason && SWEEP_OR_CANCEL_REASONS.has(reason)) {
      return {
        bucket: "swept",
        statusKey: "swept",
        label: FAILURE_REASON_LABEL[reason] ?? "Cancelled",
        tooltip:
          FAILURE_REASON_ACTION[reason] ??
          "Cancelled by a lifecycle or capacity rule — not a failure.",
      };
    }
    // cm:guard the label must name the CAUSE, not repeat "Failed" — a chip that says "Failed" for all 20 causes is the `job_failed` column rendered as pixels, and being readable without opening the transcript is the whole deliverable of ISS-877
    return {
      bucket: "failed",
      statusKey: "failed",
      label: (reason && FAILURE_REASON_LABEL[reason]) ?? "Failed",
      tooltip:
        (reason && FAILURE_REASON_ACTION[reason]) ?? "The agent step failed — see the run timeline.",
    };
  }

  // Non-terminal (running / stalled / queued / idle): defer to the plain mapping.
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
  verify: "test",
  release: "release",
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
