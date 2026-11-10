// Feedback by week (REQ-43 BC-16), drawn on the Feedback band and under the home's loop: each week's
// outcomes stacked with the bar's total on it, each segment's numbers on hover; a reader who cannot
// see it reads the same numbers as a table.

import type { HomeFeedbackWeek } from "@forge/contracts/project-home";
import { BarChartFigure, dayLabel, type LegendTone, stackCaps, toneFill } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export const FEEDBACK_OUTCOMES = ["fixed", "declined", "open"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/** What each outcome means, as its colour: fixed is done well, declined is closed without a change, open still waits. */
export const FEEDBACK_OUTCOME_TONES: Record<FeedbackOutcome, LegendTone> = { fixed: "ready", declined: "neutral", open: "you" };

/** A week's bar with its total carried by the topmost segment drawn (`cap_<outcome>`). */
export const feedbackBarsOf = (weeks: readonly HomeFeedbackWeek[]) =>
  stackCaps(weeks, FEEDBACK_OUTCOMES).map((w) => ({ ...w, label: dayLabel(w.week), tick: dayLabel(w.week) }));

export function FeedbackChart({ weeks, testId = "home-chart-feedback" }: { weeks: readonly HomeFeedbackWeek[]; testId?: string }) {
  const t = useCopy();
  const data = feedbackBarsOf(weeks);
  return (
    <BarChartFigure
      title={t("home.chart.feedback")}
      testId={testId}
      rows={data}
      stacked
      series={FEEDBACK_OUTCOMES.map((o) => ({ key: o, label: t(`home.outcome.${o}`), fill: toneFill(FEEDBACK_OUTCOME_TONES[o]) }))}
      tipOf={(w) => [t("home.chart.weekOf", { day: w.label }), ...FEEDBACK_OUTCOMES.map((o) => `${t(`home.outcome.${o}`)} ${w[o]}`)]}
      emptyText={t("home.chart.feedbackNone")}
      legendTestId="home-chart-legend"
      reader={{
        head: [t("home.chart.week"), ...FEEDBACK_OUTCOMES.map((o) => t(`home.outcome.${o}`))],
        rows: data.map((w) => [w.label, w.fixed, w.declined, w.open]),
        testId: "home-chart-table",
      }}
    />
  );
}
