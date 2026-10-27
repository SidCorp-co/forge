// What the project Dashboard shows a BA or PM, derived from reads core already answers: the acts
// that wait on them, the requirements/feedback/release figures, what lands this week and what is
// late. Lateness is core's (`ForecastLate`); nothing here decides it. Issue, run, runner and spend
// figures are Development's, not this page's.

import type { DeliveryForecast, FeedbackForecasts, Forecast, ForecastLate, RequirementForecasts, ScopeForecast } from "@forge/contracts/forecast";
import type { FeedbackSummary } from "@forge/contracts/feedback";
import { FEEDBACK_UNTRIAGED_PHASES } from "@forge/contracts/feedback";
import { REQUIREMENT_LIFECYCLE, type RequirementState } from "@forge/contracts/requirements";
import type { Said } from "@forge/contracts/said";
import { partsOf, type EtaClock } from "@/lib/i18n/eta-clock-words";
import { type Eta, etaOfFeedback, etaOfScope } from "@/features/forecast";
import type { RequirementSummary } from "@/features/requirements";
import type { ReleaseSummary } from "@/features/releases";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

type RequirementCounts = Partial<Record<RequirementState, number>>;

/** Requirements by lifecycle state, the states a BA reads, in lifecycle order; deferred only where there is one. */
export function requirementsByState(list: readonly Pick<RequirementSummary, "standing">[] | undefined): { state: RequirementState; count: number }[] {
  const tally: RequirementCounts = {};
  for (const r of list ?? []) tally[r.standing.state] = (tally[r.standing.state] ?? 0) + 1;
  const states: RequirementState[] = [...REQUIREMENT_LIFECYCLE, ...((tally.deferred ?? 0) > 0 ? (["deferred"] as const) : [])];
  return states.map((state) => ({ state, count: tally[state] ?? 0 }));
}

export interface FeedbackFigures {
  open: number;
  untriaged: number;
  /** Open items core reads stuck (`times.stuck`, REQ-48 BC-5): its rule, never an age this page picks. */
  stuck: number;
  /** Open items neither stuck nor untriaged: the work moving. With `stuck` and the untriaged that are not stuck, it makes `open`. */
  moving: number;
}

export function feedbackFigures(list: readonly Pick<FeedbackSummary, "phase" | "attentionGroup" | "times" | "snoozed">[] | undefined): FeedbackFigures {
  const open = (list ?? []).filter((f) => f.attentionGroup !== "done");
  const untriaged = (f: (typeof open)[number]) => (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(f.phase) && !f.snoozed;
  return {
    open: open.length,
    untriaged: open.filter(untriaged).length,
    stuck: open.filter((f) => f.times.stuck !== null).length,
    moving: open.filter((f) => f.times.stuck === null && !untriaged(f)).length,
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
  release: { version: string; who: Said } | null;
}

interface PlanInputs {
  slug: string;
  requirements: RequirementForecasts | undefined;
  feedback: FeedbackForecasts | undefined;
  feedbackTitles: ReadonlyMap<string, string>;
  /** The draft release and its scope forecast, where there is one. */
  release: { summary: ReleaseSummary | undefined; scope: ScopeForecast | undefined };
}

const lateOfForecast = (f: Forecast | null | undefined): ForecastLate | null => (f && (f.kind === "forecast" || f.kind === "paused") ? f.late : null);

const releaseOf = (d: DeliveryForecast | null | undefined): PlanRow["release"] =>
  d?.release?.kind === "person" && d.release.version ? { version: d.release.version, who: d.release.says.who } : null;

const lateOfDelivery = (d: DeliveryForecast | null | undefined): ForecastLate | null => lateOfForecast(d?.landing);

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
      late: lateOfDelivery(f.delivery),
      release: f.triage ? null : releaseOf(f.delivery),
    });
  }
  const { summary, scope } = i.release;
  if (summary && scope) {
    rows.push({
      kind: "release",
      key: summary.version,
      // the version is the row's key; a release cut with no name is named by its kind where it renders
      title: summary.name ?? "",
      href: releaseHref(i.slug, summary.version),
      eta: etaOfScope(scope, clock),
      late: lateOfDelivery(scope.delivery),
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
