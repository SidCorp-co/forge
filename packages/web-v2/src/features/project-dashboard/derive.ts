// web-v2 feature module: project-dashboard — PURE derivations (no React, no
// fetching) for the per-project operator dashboard (`/projects/[slug]`,
// mockup `01 Dashboard.html`). Everything here re-composes data already fetched
// by the existing `useProjectHealth` / `useAttention` / `useProjectRuns` /
// `useStepDurations` / `useDevices` + `useQueueStats` / `useSchedules` hooks —
// NO new data sources (ISS-379). Kept pure so the aggregation is unit-tested in
// `derive.test.ts` without rendering anything.
import { type StageKey, stageColor } from "@/design/stages";
import { TONE_META, type SemanticTone } from "@/design/status";
import type { AttentionView } from "@/features/attention/types";
import { jobTypeToStage, statusToStage } from "@/features/pipeline/derive";
import type { PipelineRunListItem, StepDurationRow } from "@/features/pipeline/types";
import type { ProjectHealthRow } from "@/features/projects/types";
import {
  type ActiveRunner,
  type ProjectRunner,
  type RunnerLimitDisplay,
  runnerLimitDisplay,
} from "@/features/runners/types";
import type { ScheduleRow } from "@/features/schedules/types";
import type { QueueStats } from "@/features/sessions/types";

/* ------------------------------------------------------------------ *
 * Open-issues-by-status donut (AC#4)
 * ------------------------------------------------------------------ */

export type StatusBucketKey = "active" | "attention" | "queued" | "blocked" | "ready";

/**
 * Statuses that are NOT genuinely-open work and so are EXCLUDED from the donut
 * entirely: terminal `released`/`closed` and the not-yet-active `draft`. This is
 * the same exclusion the core KPI uses (`NON_OPEN_STATUSES` in
 * `packages/core/src/projects/health-routes.ts`), so the donut center total
 * equals the top "Open issues" KPI by construction (ISS-528). Previously these
 * were bucketed into "Done" and dominated the chart (~96% noise on projects with
 * many closed issues), contradicting the KPI.
 */
const NON_OPEN_STATUSES = new Set(["awaiting_release", "closed", "draft"]);

/**
 * Display buckets for the status donut, in legend order. ISS-509: buckets are
 * grouped by SEMANTIC TONE and colored from `TONE_META` (one source of truth),
 * so a status lands on the SAME tone here as in its chip and in the overview
 * work-distribution bar. This reconciles the old disagreement where `reopen`
 * was a red "Blocked / failed" segment here but an in-progress segment on the
 * overview, and where `on_hold`/`needs_info` were painted the alarm-red of a
 * real failure: now `reopen` is `active`, `on_hold` is calm `blocked` ink, and
 * `needs_info`/`waiting` are `attention` amber. No issue STATUS maps to the red
 * `failure` tone — only a failed job/session does. ISS-528: the donut now charts
 * OPEN work only — terminal `released`/`closed` + `draft` are excluded (see
 * `NON_OPEN_STATUSES`), and `tested` moved out of the old "Done" bucket into a
 * `ready` (awaiting-release) bucket since it is still in-flight. Every OPEN
 * status maps into exactly one bucket so the donut total equals the sum of the
 * open-only distribution = `totalActive`.
 */
const STATUS_BUCKETS: ReadonlyArray<{
  key: StatusBucketKey;
  label: string;
  tone: SemanticTone;
  statuses: readonly string[];
}> = [
  { key: "active", label: "In progress", tone: "active", statuses: ["in_progress", "reopen", "developed", "testing"] },
  { key: "attention", label: "Awaiting input", tone: "attention", statuses: ["waiting", "needs_info"] },
  { key: "queued", label: "Queued", tone: "neutral", statuses: ["open", "confirmed", "clarified", "approved"] },
  { key: "blocked", label: "On hold", tone: "blocked", statuses: ["on_hold"] },
  { key: "ready", label: "Awaiting release", tone: "success", statuses: ["tested"] },
];

export interface DonutSegment {
  key: StatusBucketKey;
  label: string;
  color: string;
  count: number;
  /** Share of the total, 0–100. */
  pct: number;
}

export interface StatusDonutData {
  /** Non-empty buckets only, in legend order. */
  segments: DonutSegment[];
  total: number;
  /** Distinct pipeline stages (of 7) that hold ≥1 issue — the "across N stages"
   *  subtext on the Open-issues KPI. */
  activeStageCount: number;
}

export function statusDonut(dist: Record<string, number> | undefined): StatusDonutData {
  const d = dist ?? {};
  // cm:edge contract -> packages/core/src/projects/health-routes.ts — the donut centre must equal that route's "Open issues" KPI, so terminal `awaiting_release`/`closed` and not-yet-active `draft` are excluded from the total on both sides (ISS-528).
  let total = 0;
  for (const [status, count] of Object.entries(d)) {
    if (!NON_OPEN_STATUSES.has(status)) total += count;
  }
  const segments = STATUS_BUCKETS.map((b) => {
    const count = b.statuses.reduce((n, s) => n + (d[s] ?? 0), 0);
    return { key: b.key, label: b.label, color: TONE_META[b.tone].dot, count, pct: total > 0 ? (count / total) * 100 : 0 };
  }).filter((s) => s.count > 0);

  const stages = new Set<StageKey>();
  for (const [status, count] of Object.entries(d)) {
    if (count > 0 && !NON_OPEN_STATUSES.has(status)) stages.add(statusToStage(status));
  }
  return { segments, total, activeStageCount: stages.size };
}

/** Build a CSS `conic-gradient(...)` from ordered segments. Returns a flat fill
 *  when there are no segments so the ring never renders empty/transparent. */
export function conicGradient(segments: DonutSegment[]): string {
  if (segments.length === 0) return "var(--paper-200)";
  let acc = 0;
  const stops: string[] = [];
  for (const s of segments) {
    const start = acc;
    acc += s.pct;
    stops.push(`${s.color} ${start.toFixed(3)}% ${acc.toFixed(3)}%`);
  }
  return `conic-gradient(${stops.join(", ")})`;
}

/* ------------------------------------------------------------------ *
 * 7-day spend by stage (AC#4)
 * ------------------------------------------------------------------ */

export type SpendGroupKey = "test" | "code" | "plan" | "other";

const SPEND_GROUPS: ReadonlyArray<{ key: SpendGroupKey; label: string; color: string }> = [
  { key: "test", label: "test", color: stageColor("test") },
  { key: "code", label: "code", color: stageColor("code") },
  { key: "plan", label: "plan", color: stageColor("plan") },
  { key: "other", label: "other", color: "var(--ink-400)" },
];

/** Fold a pipeline stage into one of the four mockup spend groups. `fix` already
 *  folds onto `code` via `jobTypeToStage`; triage/clarify/review/release → other. */
function stageToSpendGroup(stage: StageKey): SpendGroupKey {
  if (stage === "test") return "test";
  if (stage === "code") return "code";
  if (stage === "plan") return "plan";
  return "other";
}

export interface SpendSegment {
  key: SpendGroupKey;
  label: string;
  color: string;
  cost: number;
  pct: number;
}

export interface SpendByStageData {
  segments: SpendSegment[];
  total: number;
}

export function spendByStage(rows: StepDurationRow[] | undefined): SpendByStageData {
  const byGroup = new Map<SpendGroupKey, number>(SPEND_GROUPS.map((g) => [g.key, 0]));
  for (const r of rows ?? []) {
    const g = stageToSpendGroup(jobTypeToStage(r.step));
    byGroup.set(g, (byGroup.get(g) ?? 0) + (r.costUsd ?? 0));
  }
  const total = [...byGroup.values()].reduce((a, b) => a + b, 0);
  const segments = SPEND_GROUPS.map((g) => {
    const cost = byGroup.get(g.key) ?? 0;
    return { key: g.key, label: g.label, color: g.color, cost, pct: total > 0 ? (cost / total) * 100 : 0 };
  }).filter((s) => s.cost > 0);
  return { segments, total };
}

/* ------------------------------------------------------------------ *
 * Live runs + in-flight spend (AC#3, AC#1)
 * ------------------------------------------------------------------ */

const LIVE_RUN_STATUSES = new Set(["running", "paused"]);

/** currentStep value for a run parked at the manual pre-release gate (issue
 *  status `tested`, awaiting a human to advance tested→released). The pipeline
 *  run stays `running` in the DB while parked here — see ISS-461: that reaper
 *  only closes runs whose issue is already `closed`/`released`, so a run
 *  legitimately parked at `tested` is untouched and looks "live" forever. */
const AWAITING_RELEASE_STEP = "tested";

/** Currently-live runs (running or paused), most recent first (the list arrives
 *  ordered by `startedAt` desc). Includes runs parked at the manual release
 *  gate — prefer `activeRuns`/`awaitingReleaseRuns` for anything user-facing. */
export function liveRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status));
}

/** Live runs that are genuinely executing a step — i.e. something is actually
 *  queued, dispatched or running on them.
 *
 *  This used to be `currentStep !== "tested"`, which only knew about ONE parked
 *  state. Every other park — `waiting`, `needs_info`, `on_hold`, or a run whose
 *  last job died — read as live forever. Measured 2026-08-11: getcontent had 14
 *  runs at status `running`, of which 3 had any live job. `liveJobs` is the fact
 *  the guess was standing in for (ISS-789). */
export function activeRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter((r) => (r.liveJobs ?? 0) > 0);
}

/** Live runs with nothing working on them — open in the DB, idle in reality.
 *  Split out from `awaitingReleaseRuns`: that one names the single expected park
 *  (the release gate); this one is everything else, which is the set nobody
 *  could see before. */
export function idleRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter(
    (r) => (r.liveJobs ?? 0) === 0 && r.currentStep !== AWAITING_RELEASE_STEP,
  );
}

/** Live runs parked at the manual release gate — tested and done, just waiting
 *  on a human to advance tested→released. Not "live" in any executing sense. */
export function awaitingReleaseRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter((r) => r.currentStep === AWAITING_RELEASE_STEP);
}

/** Sum of estimated cost across the live runs — the `+$X in flight` annotation.
 *  Prefer `activeSpend` for anything user-facing (this includes sunk cost of
 *  runs parked awaiting release, which is no longer "in flight"). */
export function inFlightSpend(runs: PipelineRunListItem[] | undefined): number {
  return liveRuns(runs).reduce((sum, r) => sum + (r.cost?.estimatedCost ?? 0), 0);
}

/** Sum of estimated cost across genuinely-active runs only. */
export function activeSpend(runs: PipelineRunListItem[] | undefined): number {
  return activeRuns(runs).reduce((sum, r) => sum + (r.cost?.estimatedCost ?? 0), 0);
}

/* ------------------------------------------------------------------ *
 * Needs-your-attention queue (AC#2)
 * ------------------------------------------------------------------ */

export type AttentionActionKind = "retry" | "diff" | "input" | "chain";

export interface DashboardAttentionItem {
  key: string;
  actionKind: AttentionActionKind;
  /** Primary-action button label. */
  actionLabel: string;
  /** What is wrong + at which step. */
  title: string;
  issueRef?: string;
  /** basePath-relative destination (Next prepends `/v2`). */
  link: string;
  since?: string;
  status?: string;
}

function mapAttention(
  items: AttentionView["failedJobs"],
  slug: string,
  actionKind: AttentionActionKind,
  actionLabel: string,
): DashboardAttentionItem[] {
  return items
    .filter((it) => it.projectSlug === slug)
    .map((it, i) => ({
      key: `${actionKind}-${it.link}-${i}`,
      actionKind,
      actionLabel,
      title: it.title,
      issueRef: it.issueRef,
      link: it.link,
      since: it.since,
      status: it.status,
    }));
}

/**
 * The project's actionable items: failed jobs (Approve & retry), review-requested
 * changes (Open diff), awaiting-input (Provide info), and blocked-on-dependency
 * issues (View chain) derived from `health.blockers`. Attention items are
 * filtered to this project by `projectSlug`; blockers are already per-project.
 */
export function projectAttention(
  view: AttentionView | undefined,
  slug: string,
  blockers: ProjectHealthRow["blockers"] | undefined,
): DashboardAttentionItem[] {
  const out: DashboardAttentionItem[] = [];
  if (view) {
    out.push(
      ...mapAttention(view.failedJobs, slug, "retry", "Approve & retry"),
      ...mapAttention(view.needsReview, slug, "diff", "Open diff"),
      ...mapAttention(view.awaitingInput, slug, "input", "Provide info"),
    );
  }
  for (const b of blockers ?? []) {
    out.push({
      key: `chain-${b.documentId}`,
      actionKind: "chain",
      actionLabel: "View chain",
      title: `Blocked — waiting at ${b.status}`,
      issueRef: b.issueId,
      link: `/projects/${slug}/issues/${b.documentId}`,
      status: b.status,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Runners (compact) (AC#5)
 * ------------------------------------------------------------------ */

export interface RunnerLine {
  id: string;
  name: string;
  platform: NonNullable<ProjectRunner["platform"]>;
  online: boolean;
  /** Accepting no new work while it finishes what it has — listed, never counted online. */
  draining: boolean;
  busy: boolean;
  running: number;
  queued: number;
  /** Rate/usage/auth limit on this device's runner for this project, or null. */
  limit: RunnerLimitDisplay | null;
  /** Issue ref the runner is executing right now (e.g. "ISS-417"), or null. */
  activeIssueRef: string | null;
  /** Pipeline stage of the current job (job type), or null when idle. */
  activeStage: string | null;
}

export interface RunnersSummary {
  lines: RunnerLine[];
  onlineCount: number;
  busyCount: number;
  total: number;
}

/**
 * Compact runner summary — every runner the PROJECT has, joined with per-device
 * queue counters and the live active-runner snapshot. When `active` is supplied,
 * `busy` and the `activeIssueRef`/`activeStage` detail come from the runner's
 * ACTUAL in-flight job; otherwise `busy` falls back to the queue running-count.
 * No utilization% (not stored — deferred to ISS-378); revoked devices dropped.
 */
// cm:guard the spine is the PROJECT's runner rows, never the caller's `/me/devices`: a device belongs to whoever paired it, so keying on the viewer's own fleet made every runner somebody else paired vanish and the card state "No runners paired yet · 0/0 online" over a project with an online box — a false claim rather than an empty list, measured on forge-dev 2026-09-09 (VISION: state-never-lies).
// cm:why `active` needs no runnerId→deviceId bridge any more — the snapshot and the spine are keyed alike, and the queue counters are the only thing still looked up by `deviceId`.
// cm:guard `online` reads the RUNNER's status as well as the device's, because the endpoint filters neither: a retired runner keeps its row (retire sets `disabled`, it does not delete) and a draining one keeps heartbeating on an online device, so counting the device alone reports capacity the pool will not offer work to. Measured on getcontent/sidpeak/dodgeprint-api 2026-09-09, each carrying a `draining` row beside a live one.
export function runnersSummary(
  projectRunners: ProjectRunner[] | undefined,
  queue: QueueStats | undefined,
  now: number = Date.now(),
  active?: ActiveRunner[] | undefined,
): RunnersSummary {
  const byDevice = new Map<string, { queued: number; running: number }>();
  for (const d of queue?.devices ?? []) {
    if (d.deviceId) byDevice.set(d.deviceId, { queued: d.queued, running: d.running });
  }
  const activeByRunner = new Map<string, ActiveRunner>();
  for (const a of active ?? []) activeByRunner.set(a.runnerId, a);

  const lines: RunnerLine[] = (projectRunners ?? [])
    .filter((r) => r.deviceStatus !== "revoked" && r.runnerStatus !== "disabled")
    .map((r) => {
      const q = (r.deviceId ? byDevice.get(r.deviceId) : undefined) ?? { queued: 0, running: 0 };
      const draining = r.runnerStatus === "draining";
      const online = r.deviceStatus === "online" && !draining;
      const act = activeByRunner.get(r.runnerId);
      const busy = act ? !!act.current : online && q.running > 0;
      return {
        id: r.runnerId,
        name: r.deviceName ?? act?.name ?? "unnamed runner",
        platform: r.platform ?? "linux",
        online,
        draining,
        busy,
        running: q.running,
        queued: q.queued,
        limit: runnerLimitDisplay(r, now),
        activeIssueRef: act?.current?.issueRef ?? null,
        activeStage: act?.current?.stage ?? null,
      };
    });
  return {
    lines,
    onlineCount: lines.filter((l) => l.online).length,
    busyCount: lines.filter((l) => l.busy).length,
    total: lines.length,
  };
}

/* ------------------------------------------------------------------ *
 * Upcoming schedules (AC#6)
 * ------------------------------------------------------------------ */

/** Schedules ordered by soonest next run (nulls last). Pure — no slicing; the
 *  card caps the visible rows. */
export function upcomingSchedules(rows: ScheduleRow[] | undefined): ScheduleRow[] {
  return [...(rows ?? [])].sort((a, b) => {
    const at = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
    const bt = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}
