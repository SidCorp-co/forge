// What the project Dashboard shows a BA or PM, derived from reads core already answers: the acts
// that wait on them, the requirements/feedback/release figures, what lands this week and what is
// late. Lateness is core's (`ForecastLate`); nothing here decides it. Issue, run, runner and spend
// figures are Development's, not this page's.

import type { DeliveryForecast, FeedbackForecasts, Forecast, ForecastLate, RequirementForecasts, ScopeForecast } from "@forge/contracts/forecast";
import type { FeedbackSummary } from "@forge/contracts/feedback";
import { FEEDBACK_UNTRIAGED_PHASES } from "@forge/contracts/feedback";
import { REQUIREMENT_LIFECYCLE, type RequirementState } from "@forge/contracts/requirements";
import { partsOf, type EtaClock } from "@/features/forecast/clock";
import { type Eta, etaOfFeedback, etaOfScope } from "@/features/forecast/eta";
import type { NeedsYouAreaKey, NeedsYouItem } from "@/features/needs-you/types";
import type { RequirementSummary } from "@/features/requirements/types";
import type { ReleaseSummary } from "@/features/releases/types";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/** The areas a BA or PM acts in. Issues, contracts and automation are the engineers' space and keep their own Needs you. */
export const BA_NEEDS_YOU_AREAS: ReadonlySet<NeedsYouAreaKey> = new Set(["requirements", "releases", "feedback", "designs"]);

export const baNeedsYou = (items: readonly NeedsYouItem[]): NeedsYouItem[] => items.filter((n) => BA_NEEDS_YOU_AREAS.has(n.area));

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

export type RequirementCounts = Partial<Record<RequirementState, number>>;

/** Requirements by lifecycle state, the states a BA reads, in lifecycle order; deferred only where there is one. */
export function requirementsByState(list: readonly Pick<RequirementSummary, "standing">[] | undefined): { state: RequirementState; count: number }[] {
  const tally: RequirementCounts = {};
  for (const r of list ?? []) tally[r.standing.state] = (tally[r.standing.state] ?? 0) + 1;
  const states: RequirementState[] = [...REQUIREMENT_LIFECYCLE, ...((tally.deferred ?? 0) > 0 ? (["deferred"] as const) : [])];
  return states.map((state) => ({ state, count: tally[state] ?? 0 }));
}

/** Feedback this old, still open, is aging. */
export const FEEDBACK_AGING_DAYS = 7;
const CLOSED_PHASES: ReadonlySet<string> = new Set(["verified", "declined"]);

export interface FeedbackFigures {
  open: number;
  untriaged: number;
  aging: number;
}

export function feedbackFigures(list: readonly Pick<FeedbackSummary, "phase" | "createdAt">[] | undefined, now: number): FeedbackFigures {
  const open = (list ?? []).filter((f) => !CLOSED_PHASES.has(f.phase));
  const cutoff = now - FEEDBACK_AGING_DAYS * 86_400_000;
  return {
    open: open.length,
    untriaged: open.filter((f) => (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(f.phase)).length,
    aging: open.filter((f) => Date.parse(f.createdAt) < cutoff).length,
  };
}

/* ------------------------------------------------------------------ *
 * Lands this week, and late
 * ------------------------------------------------------------------ */

export interface PlanRow {
  kind: "requirement" | "feedback" | "release";
  key: string;
  title: string;
  href: string;
  eta: Eta | null;
  late: ForecastLate | null;
  /** The release cut this row's delivery waits on, and who cuts it; null where no cut is owed. */
  release: { version: string; who: string } | null;
}

export interface PlanInputs {
  slug: string;
  requirements: RequirementForecasts | undefined;
  feedback: FeedbackForecasts | undefined;
  feedbackTitles: ReadonlyMap<string, string>;
  /** The draft release and its scope forecast, where there is one. */
  release: { summary: ReleaseSummary | undefined; scope: ScopeForecast | undefined };
}

const lateOfForecast = (f: Forecast | null | undefined): ForecastLate | null => (f && (f.kind === "forecast" || f.kind === "paused") ? f.late : null);

const releaseOf = (d: DeliveryForecast | null | undefined): PlanRow["release"] =>
  d?.release?.kind === "person" && d.release.version ? { version: d.release.version, who: d.release.who } : null;

const lateOfDelivery = (d: DeliveryForecast | null | undefined): ForecastLate | null => lateOfForecast(d?.landing);

function worst(...lates: (ForecastLate | null)[]): ForecastLate | null {
  return lates.reduce<ForecastLate | null>((a, l) => (l && (!a || l.byMinutes > a.byMinutes) ? l : a), null);
}

export function planRows(i: PlanInputs, clock: EtaClock): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const s of i.requirements?.requirements ?? []) {
    rows.push({ kind: "requirement", key: s.key, title: s.title ?? s.key, href: requirementHref(i.slug, s.key), eta: etaOfScope(s, clock), late: lateOfDelivery(s.delivery), release: releaseOf(s.delivery) });
  }
  for (const f of i.feedback?.items ?? []) {
    rows.push({
      kind: "feedback",
      key: f.key,
      title: i.feedbackTitles.get(f.key) ?? f.key,
      href: feedbackHref(i.slug, f.key),
      eta: etaOfFeedback(f, clock),
      late: worst(f.triage?.late ?? null, lateOfDelivery(f.delivery)),
      release: f.triage ? null : releaseOf(f.delivery),
    });
  }
  const { summary, scope } = i.release;
  if (summary && scope) {
    rows.push({
      kind: "release",
      key: summary.version,
      title: summary.headline || `Release ${summary.version}`,
      href: releaseHref(i.slug, summary.version),
      eta: etaOfScope(scope, clock),
      late: worst(lateOfDelivery(scope.delivery), scope.next?.late ?? null),
      release: null,
    });
  }
  return rows;
}

/** The Monday of the local calendar week a moment falls in, as a day number, in the clock's timezone. */
function weekStart(ms: number, timeZone: string | undefined): number {
  const p = partsOf(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d) / 86_400_000 - ((p.weekday + 6) % 7);
}

/** Rows whose forecast p50 falls in the current ISO week in the viewer's timezone, soonest first. A row waiting on a person has no time and is not here. */
export function landsThisWeek(rows: readonly PlanRow[], clock: EtaClock): PlanRow[] {
  const thisWeek = weekStart(clock.now, clock.timeZone);
  return rows
    .filter((r) => r.eta?.kind === "range" && weekStart(Date.parse(r.eta.p50At), clock.timeZone) === thisWeek)
    .sort((a, b) => Date.parse((a.eta as Extract<Eta, { kind: "range" }>).p50At) - Date.parse((b.eta as Extract<Eta, { kind: "range" }>).p50At));
}

/** Rows core calls late, the latest-running first. */
export const lateRows = (rows: readonly PlanRow[]): PlanRow[] =>
  rows.filter((r) => r.late !== null).sort((a, b) => (b.late?.byMinutes ?? 0) - (a.late?.byMinutes ?? 0));
