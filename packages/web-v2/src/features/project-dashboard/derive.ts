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
import type { DeviceRow } from "@/features/runners/types";
import type { ScheduleRow } from "@/features/schedules/types";
import type { QueueStats } from "@/features/sessions/types";

/* ------------------------------------------------------------------ *
 * Open-issues-by-status donut (AC#4)
 * ------------------------------------------------------------------ */

export type StatusBucketKey = "active" | "attention" | "queued" | "blocked" | "done";

/**
 * Display buckets for the status donut, in legend order. ISS-509: buckets are
 * grouped by SEMANTIC TONE and colored from `TONE_META` (one source of truth),
 * so a status lands on the SAME tone here as in its chip and in the overview
 * work-distribution bar. This reconciles the old disagreement where `reopen`
 * was a red "Blocked / failed" segment here but an in-progress segment on the
 * overview, and where `on_hold`/`needs_info` were painted the alarm-red of a
 * real failure: now `reopen` is `active`, `on_hold` is calm `blocked` ink, and
 * `needs_info`/`waiting` are `attention` amber. No issue STATUS maps to the red
 * `failure` tone — only a failed job/session does. Every one of the 18 statuses
 * maps into exactly one bucket so the donut total equals the sum of
 * `statusDistribution`.
 */
const STATUS_BUCKETS: ReadonlyArray<{
  key: StatusBucketKey;
  label: string;
  tone: SemanticTone;
  statuses: readonly string[];
}> = [
  { key: "active", label: "In progress", tone: "active", statuses: ["in_progress", "reopen", "developed", "deploying", "testing"] },
  { key: "attention", label: "Awaiting input", tone: "attention", statuses: ["waiting", "needs_info"] },
  { key: "queued", label: "Queued", tone: "neutral", statuses: ["open", "confirmed", "clarified", "approved", "draft"] },
  { key: "blocked", label: "On hold", tone: "blocked", statuses: ["on_hold"] },
  { key: "done", label: "Done", tone: "success", statuses: ["tested", "pass", "staging", "released", "closed"] },
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
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  const segments = STATUS_BUCKETS.map((b) => {
    const count = b.statuses.reduce((n, s) => n + (d[s] ?? 0), 0);
    return { key: b.key, label: b.label, color: TONE_META[b.tone].dot, count, pct: total > 0 ? (count / total) * 100 : 0 };
  }).filter((s) => s.count > 0);

  const stages = new Set<StageKey>();
  for (const [status, count] of Object.entries(d)) {
    if (count > 0) stages.add(statusToStage(status));
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

/** Currently-live runs (running or paused), most recent first (the list arrives
 *  ordered by `startedAt` desc). */
export function liveRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status));
}

/** Sum of estimated cost across the live runs — the `+$X in flight` annotation. */
export function inFlightSpend(runs: PipelineRunListItem[] | undefined): number {
  return liveRuns(runs).reduce((sum, r) => sum + (r.cost?.estimatedCost ?? 0), 0);
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
  platform: DeviceRow["platform"];
  online: boolean;
  busy: boolean;
  running: number;
  queued: number;
}

export interface RunnersSummary {
  lines: RunnerLine[];
  onlineCount: number;
  busyCount: number;
  total: number;
}

/**
 * Compact runner summary: the caller's devices joined with per-device queue
 * counters. `busy` = online AND ≥1 running session. No utilization% (not stored
 * — deferred to ISS-378); revoked devices are dropped.
 */
export function runnersSummary(
  devices: DeviceRow[] | undefined,
  queue: QueueStats | undefined,
): RunnersSummary {
  const byDevice = new Map<string, { queued: number; running: number }>();
  for (const d of queue?.devices ?? []) {
    if (d.deviceId) byDevice.set(d.deviceId, { queued: d.queued, running: d.running });
  }
  const lines: RunnerLine[] = (devices ?? [])
    .filter((d) => d.status !== "revoked")
    .map((d) => {
      const q = byDevice.get(d.id) ?? { queued: 0, running: 0 };
      const online = d.status === "online";
      return {
        id: d.id,
        name: d.name,
        platform: d.platform,
        online,
        busy: online && q.running > 0,
        running: q.running,
        queued: q.queued,
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
