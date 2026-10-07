import {
  FAILURE_CAUSE_PRESENTATION,
  type FailureCause,
  LEGACY_NEUTRAL_REASONS,
  type LegacyNeutralReason,
  resolveFailureCause,
} from "@forge/contracts/failure-causes";
import {
  JOB_HEARTBEAT_REAP_DEFAULT_MS,
  type RunStanding,
  SESSION_SILENCE_REAP_MS,
} from "@forge/contracts/run-standing";
import type { AgentSessionStatus } from "@forge/contracts/session-machine";
import type { StatusKey } from "@/design/status";
import { type Copy, copyLocale, copyOr, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";

export type { AgentSessionStatus };


/** A `running` session whose run core's read model reads as stuck (`runs/standing`, `state: stuck`)
 *  shows as `stalled`. The browser never decides it from a heartbeat clock of its own. */
export type AgentSessionDisplayStatus = AgentSessionStatus | "stalled";

/** The run ids and session ids of the runs core reads as stuck. */
export type StuckRuns = ReadonlySet<string>;

export function stuckRunsOf(items: readonly Pick<RunStanding, "id" | "sessionId" | "state">[] | undefined): StuckRuns {
  const stuck = new Set<string>();
  for (const run of items ?? []) {
    if (run.state !== "stuck") continue;
    stuck.add(run.id);
    if (run.sessionId) stuck.add(run.sessionId);
  }
  return stuck;
}

function isStuck(session: Pick<SessionRow, "id" | "pipelineRunId">, stuck: StuckRuns): boolean {
  return stuck.has(session.id) || (session.pipelineRunId !== null && stuck.has(session.pipelineRunId));
}

export type Liveness = "alive" | "stale" | "reaping" | "na";

export interface LivenessResult {
  state: Liveness;
  /** Time since the last heartbeat signal, or null when not gradable. */
  sinceHeartbeatMs: number | null;
  /** Milliseconds until the server auto-reaps (`stale` only); 0 once `reaping`,
   *  null when not gradable. */
  reapInMs: number | null;
}

export type SessionFailureReason = FailureCause | LegacyNeutralReason;

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
  /** Absolute checkout path the session ran in, named by its device binding.
   *  Present on the full row; older rows may be null. */
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

export type AgentSessionKind = "master" | "run_session" | "pipeline" | "chat";

export const AGENT_SESSION_KINDS: AgentSessionKind[] = [
  "master",
  "run_session",
  "pipeline",
  "chat",
];

export const SESSION_KIND_KEY: Record<AgentSessionKind, ProductCopyKey> = {
  master: "sessions.kind.master",
  run_session: "sessions.kind.run_session",
  pipeline: "sessions.kind.pipeline",
  chat: "sessions.kind.chat",
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
  if (type === "pipeline" || type === "master" || type === "run_session") {
    return type;
  }
  return "chat";
}

export function isJobDriven(
  session: Pick<SessionRow, "metadata"> & { kind?: AgentSessionKind | null },
): boolean {
  return sessionKind(session) === "pipeline";
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

/** Operator-facing label for each terminal failure reason, in the interface language, so "failed"
 *  is actionable on the list row and the detail blocker-card (ISS-378). Its text is the locale file's
 *  `sessions.reason.<cause>`; a reason the file has no word for reads null. */
export function failureReasonLabel(reason: string | null | undefined, language = "en"): string | null {
  if (!reason) return null;
  const read = (r: string) => copyOr(language, `sessions.reason.${r}`, copyOr("en", `sessions.reason.${r}`, ""));
  return read(reason) || read(resolveFailureCause(reason)) || null;
}

/** Suggested next action for a failed or stalled session, the one-line remedy on the detail blocker-card (ISS-378 AC#6). */
export function failureReasonAction(reason: string | null | undefined, language = "en"): string | null {
  if (!reason) return null;
  const read = (r: string) => copyOr(language, `sessions.reasonAction.${r}`, copyOr("en", `sessions.reasonAction.${r}`, ""));
  return read(reason) || read(resolveFailureCause(reason)) || null;
}

export function heartbeatReapMs(
  session: Pick<SessionRow, "metadata"> & { kind?: AgentSessionKind | null },
): number {
  const kind = sessionKind(session);
  return kind === "run_session" || kind === "master" ? SESSION_SILENCE_REAP_MS : JOB_HEARTBEAT_REAP_DEFAULT_MS;
}

export function deriveLiveness(
  session: Pick<
    SessionRow,
    "id" | "pipelineRunId" | "status" | "lastHeartbeatAt" | "startedAt" | "updatedAt" | "metadata" | "kind"
  >,
  stuck: StuckRuns,
  nowMs: number = Date.now(),
): LivenessResult {
  const naResult: LivenessResult = { state: "na", sinceHeartbeatMs: null, reapInMs: null };
  if (session.status !== "running") return naResult;
  if (isInteractiveSession(session)) return naResult;

  const lastSignal = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
  const lastMs = lastSignal ? new Date(lastSignal).getTime() : Number.NaN;
  const since = Number.isNaN(lastMs) ? null : nowMs - lastMs;
  if (!isStuck(session, stuck)) return { state: "alive", sinceHeartbeatMs: since, reapInMs: null };
  if (since === null) return { state: "stale", sinceHeartbeatMs: null, reapInMs: null };
  const reapMs = heartbeatReapMs(session);
  if (since <= reapMs) {
    return { state: "stale", sinceHeartbeatMs: since, reapInMs: reapMs - since };
  }
  return { state: "reaping", sinceHeartbeatMs: since, reapInMs: 0 };
}

export function deriveSessionDisplayStatus(
  session: Pick<SessionRow, "id" | "pipelineRunId" | "status" | "metadata" | "kind">,
  stuck: StuckRuns,
): AgentSessionDisplayStatus {
  if (session.status !== "running") return session.status;
  if (isInteractiveSession(session)) return "running";
  return isStuck(session, stuck) ? "stalled" : "running";
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
  language = "en",
): SessionOutcome {
  const t = productCopy(language);
  if (display === "completed" || display === "completed_via_recovery") {
    return { bucket: "success", statusKey: "done", label: t("sessions.outcome.completed"), tooltip: t("sessions.outcome.completedHint") };
  }

  if (display === "cancelled_stale") {
    return { bucket: "swept", statusKey: "swept", label: t("sessions.outcome.swept"), tooltip: t("sessions.outcome.sweptHint") };
  }

  if (display === "cancelled") {
    return { bucket: "cleanup", statusKey: "archived", label: t("sessions.outcome.cancelled"), tooltip: t("sessions.outcome.cancelledHint") };
  }

  if (display === "failed") {
    const reason = failureReason ?? null;
    const presentation = reason ? presentationOf(reason) : "failure";
    if (presentation === "cleanup") {
      return { bucket: "cleanup", statusKey: "swept", label: t("sessions.outcome.cleanedUp"), tooltip: t("sessions.outcome.cleanedUpHint") };
    }
    if (presentation === "swept") {
      return {
        bucket: "swept",
        statusKey: "swept",
        label: failureReasonLabel(reason, language) ?? t("sessions.outcome.cancelled"),
        tooltip: failureReasonAction(reason, language) ?? t("sessions.outcome.sweptRuleHint"),
      };
    }
    return {
      bucket: "failed",
      statusKey: "failed",
      label: failureReasonLabel(reason, language) ?? t("sessions.outcome.failed"),
      tooltip: failureReasonAction(reason, language) ?? t("sessions.outcome.failedHint"),
    };
  }

  return { bucket: "active", statusKey: statusToChip(display), label: display, tooltip: "" };
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

/** `useElapsed`'s format, for a duration that has stopped. */
export function formatDuration(ms: number, t: Copy): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return t("common.elapsed.hours", { h, m: String(m % 60).padStart(2, "0") });
  if (m > 0) return t("common.elapsed.minutes", { m, s: String(s % 60).padStart(2, "0") });
  return t("common.age.seconds", { n: s });
}

/** The absolute time of a stamp in the interface language (`useTimeFormat().dateTime`), or "—" when absent or invalid (older rows). */
export function formatShortTime(iso: string | null | undefined, dateTime: (at: number) => string): string {
  const ms = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(ms) ? "—" : dateTime(ms);
}

/** USD cost in the interface language's digits: sub-cent precision for tiny sessions, 2 decimals otherwise; "—" when absent. */
export function formatCost(usd: number | undefined, language = "en"): string {
  if (usd == null) return "—";
  const digits = (n: number) => new Intl.NumberFormat(copyLocale(language), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  if (usd > 0 && usd < 0.01) return `<$${digits(0.01)}`;
  return `$${digits(usd)}`;
}
