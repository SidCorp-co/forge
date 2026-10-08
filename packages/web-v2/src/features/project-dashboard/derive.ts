
import { type StageKey, stageColor } from "@/design/stages";
import { TONE_META, type SemanticTone } from "@/design/status";
import type { AttentionView } from "@/features/attention/types";
import { statusLabel } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { jobTypeToStage } from "@/features/pipeline/derive";
import type { PipelineRunListItem, StepDurationRow } from "@/features/pipeline/types";
import type { ProjectHealthRow } from "@/features/projects/types";
import {
  type ActiveRunner,
  type ProjectRunner,
  type RunnerLimitDisplay,
  runnerLimitDisplay,
} from "@/features/runners/types";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import {
  OPEN_WORK_STATES,
  type OpenWorkState,
  openWorkTotal,
  WORK_STATE_LABELS,
  type WorkState,
  workStateOf,
} from "@forge/contracts/work-state";
import type { ScheduleRow } from "@/features/schedules/types";
import type { QueueStats } from "@/features/sessions/types";

/* ------------------------------------------------------------------ *
 * Open work by state: the donut, drawn from the same counts as the tile (ISS-1156)
 * ------------------------------------------------------------------ */

const STATE_TONE: Record<OpenWorkState, SemanticTone> = {
  open: "neutral",
  in_flight: "active",
  awaiting_release: "success",
  blocked_on_person: "attention",
};

export interface DonutSegment {
  key: OpenWorkState;
  label: string;
  color: string;
  count: number;
  /** Share of the total, 0–100. */
  pct: number;
}

export interface StatusDonutData {
  segments: DonutSegment[];
  total: number;
}

/** The ring and its legend from one set of counts, so the legend adds up to the figure at the ring's centre. */
export function statusDonut(work: Partial<Record<WorkState, number>> | undefined): StatusDonutData {
  const total = openWorkTotal(work ?? {});
  const segments = OPEN_WORK_STATES.map((state) => {
    const count = work?.[state] ?? 0;
    return {
      key: state,
      label: WORK_STATE_LABELS[state],
      color: TONE_META[STATE_TONE[state]].dot,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    };
  }).filter((s) => s.count > 0);
  return { segments, total };
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

/** Fold a pipeline stage into one of the four spend groups. `fix` already folds onto `code` via
 *  `jobTypeToStage`; triage/clarify/review/release, and any job type outside the seven staged
 *  names (`drive`, `pm`, `custom`) for which `jobTypeToStage` answers `null`, go to `other`. */
function stageToSpendGroup(stage: StageKey | null): SpendGroupKey {
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

const AWAITING_RELEASE_STEP = "tested";

/** Currently-live runs (running or paused), most recent first (the list arrives
 *  ordered by `startedAt` desc). Includes runs parked at the manual release
 *  gate — prefer `activeRuns`/`awaitingReleaseRuns` for anything user-facing. */
export function liveRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status));
}

export function activeRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter((r) => (r.liveJobs ?? 0) > 0);
}

/** Live runs with no live JOB on them. Split out from `awaitingReleaseRuns`:
 *  that one names the single expected park (the release gate); this one is
 *  everything else, which is the set nobody could see before. */
export function idleRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter(
    (r) => (r.liveJobs ?? 0) === 0 && r.currentStep !== AWAITING_RELEASE_STEP,
  );
}

export function awaitingReleaseRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter((r) => r.currentStep === AWAITING_RELEASE_STEP);
}

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

/** `input` holds an open question; `parked` is stopped at a status a person moves it from, with no question. */
export type AttentionActionKind = "retry" | "diff" | "input" | "parked";

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

/** The work state's word, then the status the issue sits at. */
function parkedTitle(status: string): string {
  if (!(REGISTRY_ISSUE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Needs you: an issue is parked at \`${status}\`, which is not one of the issue statuses (${REGISTRY_ISSUE_STATUSES.join(", ")}), so no work state can word it. The server is not the release this page was built for.`,
    );
  }
  const state = WORK_STATE_LABELS[workStateOf(status as IssueStatus)];
  return `${state} — ${statusLabel(status as IssueStatus)}`;
}

/**
 * This project's items a person acts on, one per issue: a parked issue already listed for its
 * question is not listed again. Attention rows are filtered by `projectSlug`; blockers already are.
 */
export function projectAttention(
  view: AttentionView | undefined,
  slug: string,
  blockers: ProjectHealthRow["blockers"] | undefined,
): DashboardAttentionItem[] {
  const out: DashboardAttentionItem[] = [];
  const parked: DashboardAttentionItem[] = [];
  if (view) {
    const awaiting = view.awaitingInput.filter((it) => it.projectSlug === slug);
    const asked = awaiting.filter((it) => it.questionId != null);
    const silent = awaiting.filter((it) => it.questionId == null);
    out.push(
      ...mapAttention(view.failedJobs, slug, "retry", "Approve & retry"),
      ...mapAttention(view.needsReview, slug, "diff", "Open diff"),
      ...mapAttention(asked, slug, "input", "Provide info"),
    );
    parked.push(
      ...mapAttention(silent, slug, "parked", "Open issue").map((it) => ({
        ...it,
        title: it.status ? parkedTitle(it.status) : it.title,
      })),
    );
  }
  const listed = new Set([...out, ...parked].map((it) => it.link));
  for (const b of blockers ?? []) {
    const link = `/projects/${slug}/issues/${b.documentId}`;
    if (listed.has(link)) continue;
    listed.add(link);
    parked.push({
      key: `parked-${b.documentId}`,
      actionKind: "parked",
      actionLabel: "Open issue",
      title: parkedTitle(b.status),
      issueRef: b.issueId,
      link,
      status: b.status,
    });
  }
  return [...out, ...parked];
}

const ATTENTION_PARTS: ReadonlyArray<{ kind: AttentionActionKind; one: string; many: string }> = [
  { kind: "retry", one: "failed job", many: "failed jobs" },
  { kind: "diff", one: "to review", many: "to review" },
  { kind: "input", one: "issue with an open question", many: "issues with an open question" },
  { kind: "parked", one: "issue parked with no question", many: "issues parked with no question" },
];

/**
 * How much of what a person has to act on the list leaves out. Core caps each source and counts it
 * whole beside it. The two sources the people come from overlap, so core splits the attention count
 * into the part at a status the health row's parked list holds whole and the part outside it; the
 * parked total plus that part counts no issue twice. The figure says "at least", since an issue can
 * be on the page that no response counted.
 */
export interface AttentionCut {
  shown: number;
  atLeast: number;
  /** The parked and question items are the part cut, so the Issues list holds the rest. */
  peopleCut: boolean;
}

/** Said where the attention read failed: what could not be read, why, and that the figure is unknown. */
export function attentionReadFailure(reason: string): string {
  return `Needs you could not be read: ${reason}. How much it holds is unknown, so no count and no "All caught up" is shown.`;
}

/** The sentence the Needs you tile and its list say in place of a figure when the response cannot support one; null where it can. */
export function attentionRefusal(view: AttentionView | undefined, slug: string): string | null {
  if (!view) return null;
  if (view.projectTotals === undefined) {
    return "Needs you cannot say how much it leaves out: the attention response has no `projectTotals`. The server is not the release this page was built for.";
  }
  const totals = view.projectTotals[slug];
  if (totals !== undefined && typeof totals.awaitingOutsideBlockers !== "number") {
    return "Needs you cannot say how much it leaves out: the attention response's `projectTotals` have no `awaitingOutsideBlockers`. The server is not the release this page was built for.";
  }
  return null;
}

export function attentionCut(
  items: readonly DashboardAttentionItem[],
  view: AttentionView | undefined,
  slug: string,
  blockersTotal: number | undefined,
): AttentionCut | null {
  if (!view) return null;
  const refusal = attentionRefusal(view, slug);
  if (refusal !== null) throw new Error(refusal);
  const totals = view.projectTotals[slug] ?? {
    needsReview: 0,
    awaitingInput: 0,
    awaitingOutsideBlockers: 0,
    failedJobs: 0,
  };
  const listed = (kinds: readonly AttentionActionKind[]) =>
    items.filter((i) => kinds.includes(i.actionKind)).length;
  const listedPeople = listed(["input", "parked"]);
  const people = Math.max(
    listedPeople,
    totals.awaitingInput,
    (blockersTotal ?? 0) + totals.awaitingOutsideBlockers,
  );
  const atLeast =
    Math.max(totals.failedJobs, listed(["retry"])) +
    Math.max(totals.needsReview, listed(["diff"])) +
    people;
  if (atLeast <= items.length) return null;
  return { shown: items.length, atLeast, peopleCut: people > listedPeople };
}

/**
 * What the Needs you tile counts, said under its figure: items a person has to act on, by kind.
 * A failed job or a held dependency is no issue's work state, so this figure is not Blocked on a
 * person and the tile says what it is instead of sitting beside that count unexplained. Where the
 * list is cut the caption says how much of the whole it shows.
 */
export function attentionCaption(
  items: readonly DashboardAttentionItem[],
  cut: AttentionCut | null = null,
): string {
  const parts = ATTENTION_PARTS.flatMap(({ kind, one, many }) => {
    const n = items.filter((i) => i.actionKind === kind).length;
    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
  });
  const said = parts.length === 0 ? "nothing listed to act on" : `to act on: ${parts.join(" · ")}`;
  if (cut) return `${said} — ${cut.shown} of at least ${cut.atLeast}`;
  return parts.length === 0 ? "nothing to act on" : said;
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
