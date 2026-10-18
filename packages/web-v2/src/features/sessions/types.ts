import { jobKindLabel } from "@/features/overview/job-kinds";

import {
  FAILURE_CAUSE_PRESENTATION,
  type FailureCause,
  LEGACY_NEUTRAL_REASONS,
  resolveFailureCause,
} from "@forge/contracts/failure-causes";
import { TERMINAL_AGENT_SESSION_STATUSES } from "@forge/contracts/status-sets";
import { sessionStatusLabel } from "@/design/primitives/status-chip";
import { type StatusKey, STOPPED_WORD } from "@/design/status";
import { ENDING_AS_FAILED, endsAsFailedInText, OUTCOME_HOVER, sessionEndedText } from "./status-sentences";

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

/** UI-only readings of `running`: `stalled` is silent past the line `sessionSilence` draws, and
 *  `blocked` still checks in while its box reports its work blocked. */
export type AgentSessionDisplayStatus = AgentSessionStatus | "stalled" | "blocked";

export function isLiveDisplay(display: AgentSessionDisplayStatus): boolean {
  return display === "running" || display === "stalled" || display === "blocked";
}

export interface SessionBoxReport {
  incarnation: string;
  work: string;
  blockerKind: string | null;
  waitingOn: string | null;
  observedAt: string;
  /** When the box first reported this work, blocker and wait; every report restamps `observedAt`. */
  since: string;
}

/** A running session silent past this reads as quiet on every screen: `running` → `stalled`. */
export const STALLED_THRESHOLD_MS = 60_000;

/** A heartbeat moves no event, so every screen showing a running session re-reads it on this period. */
export const LIVE_READ_POLL_MS = 20_000;

export type Liveness = "alive" | "stale" | "reaping" | "na";

export interface LivenessResult {
  state: Liveness;
  /** Time since the last heartbeat signal, or null when not gradable. */
  sinceHeartbeatMs: number | null;
  /** Milliseconds until core ends the session (`stale` only); 0 once `reaping`; null where core
   *  states no limit for it, or the session is not gradable. */
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
  /** Null when `transcript` is `not-recorded`: a lane that keeps no transcript in core has no count. */
  totalMessages?: number | null;
  /** `not-recorded` for master and run_session sessions: core never holds their transcript. */
  transcript?: 'recorded' | 'not-recorded';
  /** Per-session dollar cost rolled up from usage_records, attached by the list
   *  endpoint (ISS-391). 0 when the session has no usage rows yet. */
  estimatedCost?: number;
  /** What the box last reported about this session, off its ledger; `null` where it reported nothing. */
  report?: SessionBoxReport | null;
  /** How long core lets this session go unheard before ending it; `null` where nothing does. */
  silenceLimitMs?: number | null;
  boxOnline?: boolean | null;
  /** Every issue the session holds — its leases and its job's issue — as the list names them. */
  issues?: Array<{ id: string; displayId: string; title: string; boxReturned?: boolean }>;
  runtimeState?: string | null;
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

/** Client-side filter tabs; `matchesFilter` in sessions-screen.tsx says what each one lists. */
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

/** Queued, or a box session not yet started; a chat idle between turns waits on its person (ISS-1228). */
export function isWaitingForABox(
  session: Pick<SessionRow, "status" | "metadata"> & { kind?: AgentSessionKind | null },
): boolean {
  return session.status === "queued" || (session.status === "idle" && !isInteractiveSession(session));
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
  session_stopped_checking_in: "Stopped checking in",
  turn_never_reported: "No turn ever reported",
  no_worker_online: "No runner online",
  no_client_ack: "No acknowledgement",
  skill_not_synced: "Skill not ready yet",
  user_cancelled: STOPPED_WORD,
  job_failed: "Unclassified",
  migration_zombie_cleanup: "Swept (migration)",
  issue_busy: "Issue busy",
  runner_full: "Runner at capacity",
};

/** Suggested next action for a failed/stalled session — the one-line remedy on
 *  the detail blocker-card (ISS-378 AC#6). */
export const FAILURE_REASON_ACTION: Record<SessionFailureReason, string> = {
  provider_spend_cap: "The account hit its spend cap. Raise it, or wait for the window to reset.",
  provider_usage_limit: "The account hit its usage window. It retries once the window resets.",
  provider_subscription_disabled:
    "Claude Code access is off for this organization. An admin has to turn it back on.",
  provider_auth_expired: "The runner's sign-in expired. Re-authenticate it, then Retry.",
  provider_overloaded: "The model provider was busy. Retry.",
  provider_refused_request: "The provider refused the request. Check the model and prompt settings.",
  agent_startup_failed: "The agent never got going on this runner. Check its MCP config, then Retry.",
  agent_skill_missing: "The skill hasn't reached this runner. Sync it, then Retry.",
  agent_exited_without_result: "The agent exited before reporting. Retry to start it again.",
  agent_killed: "Something killed the agent process. Check the runner logs.",
  workspace_preflight_failed: "The runner's checkout is unusable. Fix the repo path or remote.",
  workspace_disk_full: "The runner is out of disk. Free space, then Retry.",
  repo_root_contention:
    "Another job on that runner held the repo for ten minutes. Retry once it is free.",
  box_session_saturated:
    "That runner had no session slot free. The job moves to another box on its own.",
  runner_unreachable: "The box could not be reached. Check it's online, then Retry.",
  duplex_channel_failed: "The session channel dropped. A fresh session is the next step.",
  session_lost: "The session died without reporting. Retry to start it again.",
  ws_publish_failed: "The reply couldn't be delivered. Start a new chat to retry.",
  "ws-publish-failed": "The reply couldn't be delivered. Start a new chat to retry.",
  forge_budget_exhausted: "This project spent its monthly budget. Raise it or wait for the cycle.",
  runner_unsupported_type: "This runner can't run this step. Assign a runner that can.",
  resume_failed: "Resuming the previous session failed. Rerun to start fresh.",
  residency_expired: "The session outlived its window. Rerun to start fresh.",
  park_unanswered: "Nobody answered the agent's question before its deadline. The work stopped and its branch was kept.",
  audit_ran_blind: "The scheduled run called no tools, so it produced no evidence. Rerun.",
  unclassified: "The cause wasn't recorded. Open the run timeline to see why.",
  queue_timeout: "No runner picked it up. Check the fleet strip for an online runner.",
  heartbeat_timeout: "The session stopped sending heartbeats. Retry to start it again.",
  session_stopped_checking_in:
    "The session stopped checking in while its runner kept answering. Retry to start it again.",
  turn_never_reported:
    "A runner picked this up but nothing ever reported the agent starting a turn. Check whether its prompt was actually submitted, then Rerun.",
  no_worker_online: "Bring a runner online or check device pairing, then Retry.",
  no_client_ack: "The runner never acknowledged the dispatch. Retry to re-send.",
  user_cancelled: "Rerun to start a fresh session.",
  job_failed: "The cause wasn't recorded. Open the run timeline to see why.",
  issue_busy: "Another session holds this issue. It will retry once that frees.",
  runner_full: "The runner is at capacity. It will dispatch when a slot frees.",
  skill_not_synced: "The skill hadn't finished syncing to the runner yet. Start a new chat to retry.",
  orphan_under_terminal_run: "The run ended while this was still open. Nothing to do.",
  pipeline_cancelled: "The pipeline run was cancelled. Nothing to do.",
  pipeline_completed: "The run finished while this was still open. Nothing to do.",
  pipeline_failed: "The run failed and this was cleaned up with it. See the run timeline.",
  migration_zombie_cleanup: "Swept by a migration. Nothing to do.",
  manual_ops_stale_chat_schedule: "An operator cleared this stale session. Nothing to do.",
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

/** Why a session ended, as the sentences every surface says it in; `null` where core holds no reason. */
export function sessionEndText(reason: string | null | undefined): string | null {
  return reason ? sessionEndedText(reason, failureReasonLabel(reason)) : null;
}

/** A remedy that reads differently by whether the session had started (ISS-1228). */
const ACTION_BY_START: Partial<Record<SessionFailureReason, { started: string; never: string }>> = {
  runner_unreachable: {
    started: "The box stopped answering while the session ran. Check it's online, then Retry.",
    never: "The runner never picked it up. Check it's online, then Retry.",
  },
};

/** The remedy in the words of the page it is read on: `button` is that page's own, `started` whether it had started. */
export function failureReasonAction(
  reason: string | null | undefined,
  button: "Retry" | "Rerun" = "Retry",
  started?: boolean,
): string | null {
  if (!reason) return null;
  const cause = (Object.hasOwn(FAILURE_REASON_ACTION, reason) ? reason : resolveFailureCause(reason)) as SessionFailureReason;
  const byStart = started === undefined ? undefined : ACTION_BY_START[cause];
  const action = byStart ? (started ? byStart.started : byStart.never) : FAILURE_REASON_ACTION[cause];
  return action.replace(/\bRetry\b/g, button);
}

/** What a running session's silence is measured on, whichever read the session came from. */
export interface SilenceInput {
  status: string;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  updatedAt?: string | null;
  /** The silence after which core ends this session, as core states it on the row. */
  silenceLimitMs?: number | null;
  /** Whether core holds the session's box online; `null` where it names no box, absent from an older core. */
  boxOnline?: boolean | null;
}

/**
 * How long a running session has been silent — since its last check-in, else since it started —
 * which side of the one-minute line that is, and how far that is from the silence core ends the
 * session after, read off the row (ISS-1228). The session page, the sessions list, the runs tab and
 * the Pipeline page all judge a session here, so no two of them disagree about one.
 */
export function sessionSilence(session: SilenceInput, nowMs: number = Date.now()): LivenessResult {
  if (session.status !== "running") return { state: "na", sinceHeartbeatMs: null, reapInMs: null };
  const lastSignal = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt ?? null;
  const unread: LivenessResult = {
    state: session.boxOnline === false ? "stale" : "alive",
    sinceHeartbeatMs: null,
    reapInMs: null,
  };
  if (!lastSignal) return unread;
  const lastMs = new Date(lastSignal).getTime();
  if (Number.isNaN(lastMs)) return unread;

  const since = nowMs - lastMs;
  const limit = session.silenceLimitMs ?? null;
  if (limit !== null && since > limit) return { state: "reaping", sinceHeartbeatMs: since, reapInMs: 0 };
  // An offline box carries no turn, so its session is quiet however recently it was heard.
  const heard = session.boxOnline !== false && since <= STALLED_THRESHOLD_MS;
  if (heard) return { state: "alive", sinceHeartbeatMs: since, reapInMs: null };
  if (limit === null) return { state: "stale", sinceHeartbeatMs: since, reapInMs: null };
  return { state: "stale", sinceHeartbeatMs: since, reapInMs: limit - since };
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}


/** A quiet session's end in words: core fails it, it never "recovers" (ISS-1228). */
export function quietEndText(liveness: LivenessResult): string | null {
  if (liveness.state === "reaping") return ENDING_AS_FAILED;
  if (liveness.state === "stale" && liveness.reapInMs != null) {
    return endsAsFailedInText(countdown(liveness.reapInMs));
  }
  return null;
}

export function deriveLiveness(
  session: Pick<
    SessionRow,
    "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata" | "silenceLimitMs" | "boxOnline"
  >,
  nowMs: number = Date.now(),
): LivenessResult {
  const gradable = !isInteractiveSession(session) || session.boxOnline === false;
  if (!gradable) return { state: "na", sinceHeartbeatMs: null, reapInMs: null };
  return sessionSilence(session, nowMs);
}

export function deriveSessionDisplayStatus(
  session: Pick<
    SessionRow,
    | "status"
    | "lastHeartbeatAt"
    | "startedAt"
    | "updatedAt"
    | "metadata"
    | "report"
    | "silenceLimitMs"
    | "boxOnline"
  >,
  nowMs: number = Date.now(),
): AgentSessionDisplayStatus {
  if (session.status !== "running") return session.status;
  const { state } = deriveLiveness(session, nowMs);
  if (state === "stale" || state === "reaping") return "stalled";
  return session.report?.work === "blocked" ? "blocked" : "running";
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
    case "blocked":
      return "blocked";
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
  started?: boolean,
): SessionOutcome {
  if (display === "completed" || display === "completed_via_recovery") {
    return { bucket: "success", statusKey: "done", label: "Completed", tooltip: OUTCOME_HOVER.completed };
  }

  if (display === "cancelled_stale") {
    return {
      bucket: "swept",
      statusKey: "swept",
      label: "Swept (overdue)",
      tooltip: OUTCOME_HOVER.sweptStale,
    };
  }

  if (display === "cancelled") {
    return {
      bucket: "cleanup",
      statusKey: "archived",
      label: STOPPED_WORD,
      tooltip: OUTCOME_HOVER.stopped,
    };
  }

  if (display === "failed" && failureReason === "user_cancelled") {
    return {
      bucket: "swept",
      statusKey: "archived",
      label: STOPPED_WORD,
      tooltip: OUTCOME_HOVER.personStopped,
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
        tooltip: OUTCOME_HOVER.cleanedUp,
      };
    }
    if (presentation === "swept") {
      return {
        bucket: "swept",
        statusKey: "swept",
        label: failureReasonLabel(reason) ?? "Cancelled",
        tooltip: failureReasonAction(reason, "Retry", started) ?? OUTCOME_HOVER.ruleEnded,
      };
    }
    return {
      bucket: "failed",
      statusKey: "failed",
      label: failureReasonLabel(reason) ?? "Failed",
      tooltip: failureReasonAction(reason, "Retry", started) ?? OUTCOME_HOVER.failed,
    };
  }

  return {
    bucket: "active",
    statusKey: statusToChip(display),
    label: display,
    tooltip: "",
  };
}

/** The chip a session shows: its outcome's once it has ended, so a person's stop reads Stopped and
 *  never Failed, and its live state's before that. */
export function sessionChipStatus(display: AgentSessionDisplayStatus, failureReason?: string | null): StatusKey {
  const outcome = classifySessionOutcome(display, failureReason);
  return outcome.bucket === "active" ? statusToChip(display) : outcome.statusKey;
}

/** One chip on the list row, the page and the rail, never Idle on one of them (ISS-1228). */
export function sessionChipStatusOf(
  session: Pick<SessionRow, "status" | "metadata" | "failureReason"> & { kind?: AgentSessionKind | null },
  display: AgentSessionDisplayStatus,
): StatusKey {
  return isAwaitingReply(session) ? "waiting" : sessionChipStatus(display, session.failureReason);
}

/** The box dot a session's row draws: on every session core has not ended that names a box, of any
 *  kind, healthy while the box answers and the session is heard from, attention where either is not. */
export function boxDotOf(
  session: Pick<
    SessionRow,
    "status" | "deviceId" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata" | "silenceLimitMs" | "boxOnline"
  >,
  nowMs: number,
): "healthy" | "attention" | null {
  if (!session.deviceId || TERMINAL_SESSION_STATUSES.has(session.status)) return null;
  if (session.boxOnline === false) return "attention";
  const { state } = deriveLiveness(session, nowMs);
  return state === "stale" || state === "reaping" ? "attention" : "healthy";
}

export function sessionEndWord(display: AgentSessionDisplayStatus, failureReason?: string | null): string {
  return sessionStatusLabel(sessionChipStatus(display, failureReason));
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
    if (trimmed !== "") return jobKindLabel(trimmed);
  }
  return null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Core titles a step session `<skill or job type>: <issue>`; any other title is printed as written. */
export function sessionTitle(session: {
  title: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}): string | null {
  const jobType = text(session.metadata?.jobType);
  if (session.title === null || jobType === null) return session.title;
  const head = text(session.metadata?.skillName) ?? jobType;
  if (session.title === head) return jobKindLabel(jobType);
  if (session.title.startsWith(`${head}: `)) {
    return `${jobKindLabel(jobType)}: ${session.title.slice(head.length + 2)}`;
  }
  return session.title;
}

/** Whether a session can be retried (job-driven sessions tied to an issue). */
export function isRetryable(row: SessionRow): boolean {
  return isJobDriven(row) && !!row.metadata?.issueId;
}
