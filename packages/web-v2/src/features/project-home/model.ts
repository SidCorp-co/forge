// What the home draws from its one read (`GET /api/projects/:id/home`): each stage's parts, the
// Delivery board's columns and the charts' marks. Every number is the read's; this only groups and
// places them, so a part's count always sums back to the figure its stage shows.

import type { HomeCount, HomeFeedbackWeek, HomeIssue, HomeShipDay, ProjectHome } from "@forge/contracts/project-home";
import type { IssueStatus } from "@forge/contracts/issue-machine";
import type { ReleaseState } from "@forge/contracts/releases";
import type { RequirementState } from "@forge/contracts/requirements";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export const STAGE_IDS = ["product", "delivery", "release", "audit"] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** The categorical series colours, the theme's chart tokens in a fixed order (both themes). */
export const SERIES = ["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;

export interface Part {
  key: string;
  label: ProductCopyKey;
  count: number;
}

function partsOf<K extends string>(counts: readonly HomeCount<K>[], groups: readonly { key: string; label: ProductCopyKey; of: readonly K[] }[]): Part[] {
  const tally = new Map(counts.map((c) => [c.key, c.count]));
  return groups.map((g) => ({ key: g.key, label: g.label, count: g.of.reduce((n, k) => n + (tally.get(k) ?? 0), 0) }));
}

const PRODUCT_PARTS: { key: string; label: ProductCopyKey; of: RequirementState[] }[] = [
  { key: "building", label: "home.part.building", of: ["in_delivery"] },
  { key: "agreed", label: "home.part.agreed", of: ["agreed"] },
  { key: "done", label: "home.part.done", of: ["delivered", "accepted"] },
  { key: "draft", label: "home.part.draft", of: ["draft"] },
  { key: "deferred", label: "home.part.deferred", of: ["deferred"] },
];

/** The Delivery board's columns, each the statuses it holds; every open status is in one. */
export const DELIVERY_COLUMNS: { key: string; label: ProductCopyKey; of: IssueStatus[] }[] = [
  { key: "queued", label: "home.part.queued", of: ["draft", "open", "reopen", "approved"] },
  { key: "building", label: "home.part.building", of: ["in_progress"] },
  { key: "held", label: "home.part.held", of: ["on_hold", "needs_info"] },
  { key: "landed", label: "home.part.landed", of: ["awaiting_release"] },
];

const RELEASE_PARTS: { key: string; label: ProductCopyKey; of: ReleaseState[] }[] = [
  { key: "shipped", label: "home.part.shipped", of: ["shipped"] },
  { key: "going", label: "home.part.going", of: ["in_progress", "awaiting_approval", "returned", "landed"] },
  { key: "failed", label: "home.part.failed", of: ["failed"] },
  { key: "aborted", label: "home.part.aborted", of: ["aborted"] },
];

const AUDIT_PARTS: { key: string; label: ProductCopyKey; of: ("red" | "debt" | "simplify")[] }[] = [
  { key: "debt", label: "home.kind.debt", of: ["debt"] },
  { key: "simplify", label: "home.kind.simplify", of: ["simplify"] },
  { key: "red", label: "home.kind.red", of: ["red"] },
];

export const stageParts = (home: ProjectHome): Record<StageId, Part[]> => ({
  product: partsOf(home.product.byState, PRODUCT_PARTS),
  delivery: partsOf(home.delivery.byStatus, DELIVERY_COLUMNS),
  release: partsOf(home.release.byState, RELEASE_PARTS),
  audit: partsOf(home.audit.byKind, AUDIT_PARTS),
});

/** A share of a whole, 0 where there is no whole. */
export const shareOf = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Each board column's issues, in the read's order (newest write first). */
export function boardOf(issues: readonly HomeIssue[]): Map<string, HomeIssue[]> {
  const columnOf = new Map(DELIVERY_COLUMNS.flatMap((c) => c.of.map((s) => [s, c.key] as const)));
  const board = new Map(DELIVERY_COLUMNS.map((c) => [c.key, [] as HomeIssue[]]));
  for (const i of issues) board.get(columnOf.get(i.status) ?? "")?.push(i);
  return board;
}

/** How far along build → test → release an issue is: 0 before building, 3 once it landed. */
export function trackOf(i: Pick<HomeIssue, "status" | "step">): number {
  if (i.status === "awaiting_release") return 3;
  if (i.status !== "in_progress" && i.status !== "on_hold" && i.status !== "needs_info") return 0;
  return i.step === "release" ? 3 : i.step === "test" ? 2 : i.step === "build" ? 1 : 0;
}

export const isHighPriority = (priority: string) => priority === "high" || priority === "urgent" || priority === "critical";

const DAY_LABEL = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** A `YYYY-MM-DD` key as a reader names the day: `Nov 8`. */
export const dayLabel = (key: string) => DAY_LABEL.format(new Date(`${key}T12:00:00Z`));

export interface ShipChart {
  /**
   * One per day. `mark` is the value printed over the bar, set on the highest day and today only and
   * null elsewhere: the label reads it off its own bar, because a chart draws no bar for a zero day and
   * an index into the drawn bars is not an index into the days.
   */
  points: (HomeShipDay & { label: string; tick: string; mark: number | null })[];
  average: number;
}

export function shipChartOf(days: readonly HomeShipDay[]): ShipChart {
  const peak = days.reduce((best, d, i) => (d.issues > (days[best]?.issues ?? -1) ? i : best), 0);
  const labelled = new Set([peak, days.length - 1]);
  const points = days.map((d, i) => ({
    ...d,
    label: dayLabel(d.day),
    tick: String(Number(d.day.slice(8))),
    mark: labelled.has(i) && d.issues > 0 ? d.issues : null,
  }));
  const total = days.reduce((n, d) => n + d.issues, 0);
  return { points, average: days.length ? total / days.length : 0 };
}

export const FEEDBACK_OUTCOMES = ["fixed", "declined", "open"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/**
 * A week's bar with its total carried by the topmost segment drawn (`cap_<outcome>`, null on the
 * others): a zero segment is not drawn, so a total hung on a fixed segment vanishes with it.
 */
export function feedbackBarsOf(weeks: readonly HomeFeedbackWeek[]) {
  return weeks.map((w) => {
    const total = w.fixed + w.declined + w.open;
    const top = [...FEEDBACK_OUTCOMES].reverse().find((o) => w[o] > 0) ?? null;
    const caps = Object.fromEntries(FEEDBACK_OUTCOMES.map((o) => [`cap_${o}`, o === top ? total : null])) as Record<`cap_${FeedbackOutcome}`, number | null>;
    return { ...w, label: dayLabel(w.week), total, ...caps };
  });
}

/** An average as the chart says it: whole above ten, one decimal below. */
export const averageText = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
