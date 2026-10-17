
import { TONE_META, type SemanticTone } from "@/design/status";
import { failedJobWords } from "@/features/attention/failed-job-words";
import type { AttentionView } from "@/features/attention/types";
import { statusLabel } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { jobKindsLabel } from "@/features/overview/job-kinds";
import type { PipelineRunListItem, StepDurationRow } from "@/features/runs/types";
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
import type { QueueStats } from "@/features/sessions/types";
import type { LiveSession } from "@/features/pipeline/types";
import { sessionName } from "@/features/pipeline/derive";

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
 * 7-day spend by step (AC#4)
 * ------------------------------------------------------------------ */

/** Neutral ink for the three costliest kinds of work, then "Other": a kind carries no colour of its own. */
const SPEND_INK = ["var(--fg-default)", "var(--fg-muted)", "var(--fg-subtle)"] as const;
const OTHER_INK = "var(--border-strong)";
export const SPEND_OTHER_KEY = "other";

export interface SpendSegment {
  /** The step exactly as the rows name it, or `other` for everything past the three costliest. */
  key: string;
  /** The kind of work in the Overview's words, never the stored step name. */
  label: string;
  color: string;
  cost: number;
  pct: number;
}

export interface SpendByStepData {
  segments: SpendSegment[];
  total: number;
}

/** The window's spend by step, named in the Overview's words: the three costliest, then Other. */
export function spendByStep(rows: StepDurationRow[] | undefined): SpendByStepData {
  const byStep = new Map<string, number>();
  for (const r of rows ?? []) byStep.set(r.step, (byStep.get(r.step) ?? 0) + (r.costUsd ?? 0));
  const ranked = [...byStep.entries()]
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.reduce((a, [, cost]) => a + cost, 0);
  const pct = (cost: number) => (total > 0 ? (cost / total) * 100 : 0);
  const segments: SpendSegment[] = ranked.slice(0, SPEND_INK.length).map(([step, cost], i) => ({
    key: step,
    label: jobKindsLabel(step),
    color: SPEND_INK[i] as string,
    cost,
    pct: pct(cost),
  }));
  const rest = ranked.slice(SPEND_INK.length).reduce((a, [, cost]) => a + cost, 0);
  if (rest > 0) {
    segments.push({ key: SPEND_OTHER_KEY, label: "Other", color: OTHER_INK, cost: rest, pct: pct(rest) });
  }
  return { segments, total };
}

/* ------------------------------------------------------------------ *
 * Open runs + in-flight spend (AC#3, AC#1)
 * ------------------------------------------------------------------ */

const LIVE_RUN_STATUSES = new Set(["running", "paused"]);

const AWAITING_RELEASE_STEP = "tested";

/** Currently-live runs (running or paused), most recent first (the list arrives
 *  ordered by `startedAt` desc). Includes runs parked at the manual release
 *  gate — prefer `activeRuns`/`awaitingReleaseRuns` for anything user-facing. */
export function liveRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? []).filter((r) => LIVE_RUN_STATUSES.has(r.status));
}

/** Something is working the run: a live job on it, or a session on it that has not ended. */
function worked(r: PipelineRunListItem): boolean {
  return (r.liveJobs ?? 0) > 0 || r.lastSessionBeatAt != null;
}

/** Live runs something is working. A driver run holds no job, so a job count alone reads it as idle. */
export function activeRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter(worked);
}

/** Live runs off the release gate with no live job: the set a run goes stuck from, whatever a session on it last said. */
export function joblessRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return liveRuns(runs).filter(
    (r) => (r.liveJobs ?? 0) === 0 && r.currentStep !== AWAITING_RELEASE_STEP,
  );
}

/** Live runs off the release gate that nothing works: no live job, and no session on them that has not ended. */
export function idleRuns(runs: PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return joblessRuns(runs).filter((r) => !worked(r));
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
export type AttentionActionKind = "retry" | "diff" | "input" | "parked" | "session";

export interface DashboardAttentionItem {
  key: string;
  actionKind: AttentionActionKind;
  /** Primary-action button label. */
  actionLabel: string;
  /** What is wrong + at which step, or the issue's own title where `detail` says why it is listed. */
  title: string;
  /** Why the issue is listed, read under its title. */
  detail?: string;
  issueRef?: string;
  /** basePath-relative destination (Next prepends `/v2`). */
  link: string;
  /** When the wait began: the state entered or the question opened, never a last write. */
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
    .map((it, i) => ({ it, i, said: actionKind === "retry" ? failedJobWords(it) : it.title }))
    // A failed job is said in words, under its issue's title where it ran for one (ISS-1229 r14).
    .map(({ it, i, said }) => ({
      key: `${actionKind}-${it.link}-${i}`,
      actionKind,
      actionLabel,
      ...(it.issueTitle ? { title: it.issueTitle, detail: said } : { title: said }),
      issueRef: it.issueRef,
      link: it.link,
      since: it.since,
      status: it.status,
    }));
}

function ageOf(since: string | undefined): { since?: string } {
  return since ? { since } : {};
}

/** Why a parked issue is listed: the work state's word, then the status it sits at. */
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
  /** The parked issues' ages by issue id; a blocker with none is listed without a time. */
  ages?: ReadonlyMap<string, string>,
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
        ...(it.status ? { detail: parkedTitle(it.status) } : {}),
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
      title: b.title,
      detail: parkedTitle(b.status),
      issueRef: b.issueId,
      link,
      status: b.status,
      ...ageOf(ages?.get(b.documentId)),
    });
  }
  return [...out, ...parked];
}

/**
 * The live sessions whose box reports them blocked on a person (ISS-1228): a person has to act for
 * each to go on, so each is one item to act on, in the box's own words, aged from when the box first
 * reported that wait. A session blocked on a machine, another agent or nobody waits on no person and
 * is not listed.
 */
export function sessionsWaitingOnYou(
  sessions: readonly LiveSession[] | undefined,
  slug: string,
): DashboardAttentionItem[] {
  return (sessions ?? [])
    .filter((s) => s.report?.work === "blocked" && s.report.blockerKind === "human")
    .map((s) => ({
      key: `session-${s.id}`,
      actionKind: "session" as const,
      actionLabel: "Open session",
      title: s.report?.waitingOn
        ? `${sessionName(s)} waits on you — ${s.report.waitingOn}`
        : `${sessionName(s)} waits on you`,
      ...(s.issues[0] ? { issueRef: s.issues[0].displayId } : {}),
      link: `/projects/${slug}/agents/${s.id}`,
      ...ageOf(s.report?.since),
    }));
}

const ATTENTION_PARTS: ReadonlyArray<{ kind: AttentionActionKind; one: string; many: string }> = [
  { kind: "retry", one: "failed job", many: "failed jobs" },
  { kind: "diff", one: "to review", many: "to review" },
  { kind: "input", one: "issue with an open question", many: "issues with an open question" },
  { kind: "parked", one: "issue parked with no question", many: "issues parked with no question" },
  { kind: "session", one: "session waiting on you", many: "sessions waiting on you" },
];

/**
 * How much of what a person has to act on the list leaves out. Core caps each source and counts it
 * whole beside it: the project's failed jobs, reviews and parks the reader owes, plus the parked
 * issues no bucket lists (`parkedOnly`), so the parts add up to the whole with no issue counted
 * twice, and the sessions waiting on the person are listed whole. The figure is that whole, never
 * "at least" (ISS-1229 r14).
 */
export interface AttentionCut {
  shown: number;
  whole: number;
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
  if (totals !== undefined && typeof totals.parkedOnly !== "number") {
    return "Needs you cannot say how much it leaves out: the attention response's `projectTotals` have no `parkedOnly`. The server is not the release this page was built for.";
  }
  return null;
}

export function attentionWhole(
  items: readonly DashboardAttentionItem[],
  view: AttentionView | undefined,
  slug: string,
): number {
  const refusal = attentionRefusal(view, slug);
  if (refusal !== null) throw new Error(refusal);
  const totals = view?.projectTotals[slug];
  const sessions = items.filter((i) => i.actionKind === "session").length;
  if (!totals) return items.length;
  return totals.failedJobs + totals.needsReview + totals.awaitingInput + totals.parkedOnly + sessions;
}

export function attentionCut(
  items: readonly DashboardAttentionItem[],
  view: AttentionView | undefined,
  slug: string,
): AttentionCut | null {
  if (!view) return null;
  const whole = attentionWhole(items, view, slug);
  if (whole <= items.length) return null;
  const totals = view.projectTotals[slug];
  const listedPeople = items.filter((i) => i.actionKind === "input" || i.actionKind === "parked").length;
  const people = (totals?.awaitingInput ?? 0) + (totals?.parkedOnly ?? 0);
  return { shown: items.length, whole, peopleCut: people > listedPeople };
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
  if (cut) return `${said} — ${cut.shown} of ${cut.whole} listed`;
  return parts.length === 0 ? "nothing to act on" : said;
}

/* ------------------------------------------------------------------ *
 * Runners (compact) (AC#5)
 * ------------------------------------------------------------------ */

export interface RunnerLine {
  id: string;
  deviceId: string | null;
  name: string;
  platform: NonNullable<ProjectRunner["platform"]>;
  online: boolean;
  /** Accepting no new work while it finishes what it has — listed, never counted online. */
  draining: boolean;
  /** Hosting a live session, or running a pool job or the active-runner snapshot's current one. */
  busy: boolean;
  /** Live sessions on this runner's device, as the Pipeline page lists them. */
  sessions: number;
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
  /** Online runners that are busy: the caption reads it against `onlineCount`. */
  busyCount: number;
  total: number;
}

export function runnersSummary(
  projectRunners: ProjectRunner[] | undefined,
  queue: QueueStats | undefined,
  now: number = Date.now(),
  active?: ActiveRunner[] | undefined,
  sessions?: readonly Pick<LiveSession, "deviceId">[] | undefined,
): RunnersSummary {
  const sessionsByDevice = new Map<string, number>();
  for (const s of sessions ?? []) {
    if (s.deviceId) sessionsByDevice.set(s.deviceId, (sessionsByDevice.get(s.deviceId) ?? 0) + 1);
  }
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
      const hosted = (r.deviceId ? sessionsByDevice.get(r.deviceId) : undefined) ?? 0;
      const busy = hosted > 0 || (act ? !!act.current : online && q.running > 0);
      return {
        id: r.runnerId,
        deviceId: r.deviceId ?? null,
        name: r.deviceName ?? act?.name ?? "unnamed runner",
        platform: r.platform ?? "linux",
        online,
        draining,
        busy,
        sessions: hosted,
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
    busyCount: lines.filter((l) => l.online && l.busy).length,
    total: lines.length,
  };
}
