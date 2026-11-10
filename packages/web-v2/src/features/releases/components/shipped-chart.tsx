// Issues shipped per day (REQ-43 BC-16), drawn on the Releases band and under the home's loop: its
// highest day and today labelled, its average a dashed line, each bar's numbers on hover; a reader who
// cannot see it reads the same numbers as a table.

import type { HomeShipDay } from "@forge/contracts/project-home";
import { averageText, BarChartFigure, dayLabel, dayTick, peakCaps } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export interface ShipChart {
  /** One per day; `mark` (and `cap_issues`, the same) is printed over the bar on the highest day and today only. */
  points: (HomeShipDay & { label: string; tick: string; mark: number | null; cap_issues: number | null })[];
  average: number;
}

export function shipChartOf(days: readonly HomeShipDay[]): ShipChart {
  const marks = peakCaps(days.map((d) => d.issues));
  const points = days.map((d, i) => ({ ...d, label: dayLabel(d.day), tick: dayTick(d.day), mark: marks[i] ?? null, cap_issues: marks[i] ?? null }));
  const total = days.reduce((n, d) => n + d.issues, 0);
  return { points, average: days.length ? total / days.length : 0 };
}

export function ShippedChart({ days, testId = "home-chart-shipped" }: { days: readonly HomeShipDay[]; testId?: string }) {
  const t = useCopy();
  const chart = shipChartOf(days);
  return (
    <BarChartFigure
      title={t("home.chart.shipped")}
      testId={testId}
      rows={chart.points}
      series={[{ key: "issues", label: t("home.chart.issues"), fill: "var(--chart-2)" }]}
      average={{ value: chart.average, label: t("home.chart.average", { n: averageText(chart.average) }) }}
      tipOf={(p) => [p.label, t("home.chart.tipShipped", { r: p.releases, n: p.issues })]}
      emptyText={t("home.chart.shippedNone")}
      reader={{
        head: [t("home.chart.day"), t("home.chart.releases"), t("home.chart.issues")],
        rows: chart.points.map((p) => [p.label, p.releases, p.issues]),
        testId: "home-chart-table",
      }}
    />
  );
}
