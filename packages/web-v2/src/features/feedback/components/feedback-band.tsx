// The Feedback page's overview (REQ-43 r3 BC-14..BC-17): how many reports there are and how many are
// still open, the flow of their phases each with its count, and feedback by week by how it ended, in
// the reader's weeks. A duplicate counts under its original, never beside it, the home's rule
// (`project-home.ts:feedbackWeeksOf`) over the very rows the list under it holds (L-57).

import { countsAsReport, FEEDBACK_PHASES } from "@forge/contracts/feedback";
import { feedbackOutcomeOf, feedbackWeeksOf } from "@forge/contracts/project-home";
import { OverviewBand, readerDays, stateFlowOf } from "@/design";
import { FeedbackChart } from "./feedback-chart";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { FeedbackSummary } from "../types";

export function FeedbackBand({ rows }: { rows: readonly FeedbackSummary[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const reports = rows.filter(countsAsReport);
  const { dayOf, today } = readerDays();
  return (
    <OverviewBand
      label={t("feedback.band.label")}
      testId="feedback-band"
      figures={[
        { key: "reports", value: reports.length, label: t("feedback.band.reports") },
        { key: "open", value: reports.filter((r) => feedbackOutcomeOf(r) === "open").length, label: t("feedback.band.open") },
      ]}
      flow={stateFlowOf("feedbackPhase", FEEDBACK_PHASES, reports.map((r) => r.phase), language)}
      chart={<FeedbackChart weeks={feedbackWeeksOf(reports, dayOf, today)} testId="feedback-band-chart" />}
    />
  );
}
