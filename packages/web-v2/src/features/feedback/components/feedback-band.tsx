// The Feedback page's overview (REQ-43 r3 BC-14..BC-17): how many reports there are and how many are
// still open, the flow of the list's own groups each with its count, and feedback by week by how it
// ended, in the reader's weeks. The figures and the flow are core's counts over the very reports the
// list under it groups, by the same groups (ISS-1197 r2): a duplicate is its original's occurrence,
// counted and listed under it, never beside it (REQ-66 BC-3). The chart reads the home's rule
// (`project-home.ts:feedbackWeeksOf`) over those reports (L-57).

import { FEEDBACK_ATTENTION_GROUPS, FEEDBACK_ATTENTION_LABELS, type FeedbackListResponse } from "@forge/contracts/feedback";
import { feedbackWeeksOf } from "@forge/contracts/project-home";
import { OverviewBand, readerDays } from "@/design";
import { FeedbackChart } from "./feedback-chart";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { FeedbackSummary } from "../types";

export function FeedbackBand({ read, reports }: { read: Pick<FeedbackListResponse, "counts" | "total" | "open">; reports: readonly FeedbackSummary[] }) {
  const t = useCopy();
  const label = useLabel();
  const { dayOf, today } = readerDays();
  return (
    <OverviewBand
      label={t("feedback.band.label")}
      testId="feedback-band"
      figures={[
        { key: "reports", value: read.total, label: t("feedback.band.reports") },
        { key: "open", value: read.open, label: t("feedback.band.open") },
      ]}
      // a group no report sits in is not drawn: "Overdue 0" is a word on the face that says nothing
      flow={FEEDBACK_ATTENTION_GROUPS.filter((g) => read.counts[g] > 0).map((g) => ({
        key: g,
        label: label("feedbackAttention", g),
        count: read.counts[g],
        tone: FEEDBACK_ATTENTION_LABELS[g].tone,
      }))}
      chart={<FeedbackChart weeks={feedbackWeeksOf(reports, dayOf, today)} testId="feedback-band-chart" />}
    />
  );
}
