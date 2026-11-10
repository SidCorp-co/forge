// The two charts under the loop (REQ-43 BC-16), drawn again by the Releases and Feedback bands:
// issues shipped per day, its highest day and today labelled and its average drawn as a dashed line,
// and feedback by week, each bar's total on it. Each carries its own numbers on hover; a reader who
// cannot see it reads the same numbers as a table.

import type { HomeFeedbackWeek, HomeShipDay } from "@forge/contracts/project-home";
import { averageText, BarChartFigure, toneFill } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { FEEDBACK_OUTCOME_TONES, FEEDBACK_OUTCOMES as OUTCOMES, feedbackBarsOf, SERIES, shipChartOf } from "../model";

export function ShippedChart({ days, testId = "home-chart-shipped" }: { days: readonly HomeShipDay[]; testId?: string }) {
  const t = useCopy();
  const chart = shipChartOf(days);
  return (
    <BarChartFigure
      title={t("home.chart.shipped")}
      testId={testId}
      rows={chart.points}
      series={[{ key: "issues", label: t("home.chart.issues"), fill: SERIES[0] }]}
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

export function FeedbackChart({ weeks, testId = "home-chart-feedback" }: { weeks: readonly HomeFeedbackWeek[]; testId?: string }) {
  const t = useCopy();
  const data = feedbackBarsOf(weeks);
  return (
    <BarChartFigure
      title={t("home.chart.feedback")}
      testId={testId}
      rows={data}
      stacked
      series={OUTCOMES.map((o) => ({ key: o, label: t(`home.outcome.${o}`), fill: toneFill(FEEDBACK_OUTCOME_TONES[o]) }))}
      tipOf={(w) => [t("home.chart.weekOf", { day: w.label }), ...OUTCOMES.map((o) => `${t(`home.outcome.${o}`)} ${w[o]}`)]}
      emptyText={t("home.chart.feedbackNone")}
      legendTestId="home-chart-legend"
      reader={{
        head: [t("home.chart.week"), ...OUTCOMES.map((o) => t(`home.outcome.${o}`))],
        rows: data.map((w) => [w.label, w.fixed, w.declined, w.open]),
        testId: "home-chart-table",
      }}
    />
  );
}
