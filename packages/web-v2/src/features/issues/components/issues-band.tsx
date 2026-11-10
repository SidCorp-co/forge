// The Issues page's overview (REQ-43 r3 BC-14..BC-17): how many the list draws as Moving and how many
// closed over the last days, the flow of the listed issues by status each with its count, and issues
// filed against closed per day in the reader's days (`issues/flow`, one small read beside the list).
// The flow counts the very rows the list under it holds (L-57); the scope switch's counts stay the
// toolbar's and are not said again here.

import type { IssueFlowDay } from "@forge/contracts/issue-flow";
import { ISSUE_FLOW_DAYS } from "@forge/contracts/issue-flow";
import { ISSUE_STATUSES } from "@forge/contracts/issue-machine";
import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { BarChartFigure, dayLabel, dayTick, OverviewBand, pairCaps, stateFlowOf, toneFill } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useIssueFlow } from "../hooks";

const SERIES = ["opened", "closed"] as const;
/** New work arriving reads as running, a close as done well. */
const TONES = { opened: "run", closed: "ready" } as const;

/** Each day's bars, the highest and today's value of each series printed on its own row, one per day. */
export function flowBarsOf(days: readonly IssueFlowDay[]) {
  const caps = pairCaps(days, "opened", "closed");
  return days.map((d, i) => ({ ...d, label: dayLabel(d.day), tick: dayTick(d.day), ...caps[i] }));
}

export function IssuesBand({ projectId, rows }: { projectId: string; rows: readonly IssueStandingRow[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const flow = useIssueFlow(projectId).data;
  const bars = flowBarsOf(flow?.days ?? []);
  return (
    <OverviewBand
      label={t("issues.band.label")}
      testId="issues-band"
      figures={[
        { key: "moving", value: rows.filter((r) => r.standing.attentionGroup === "moving").length, label: t("issues.attention.moving") },
        { key: "closed", value: flow ? bars.reduce((n, d) => n + d.closed, 0) : "–", label: t("issues.band.closedIn", { n: ISSUE_FLOW_DAYS }) },
      ]}
      flow={stateFlowOf("issue", ISSUE_STATUSES, rows.map((r) => r.status), language)}
      chart={
        flow ? (
        <BarChartFigure
          title={t("issues.band.chart")}
          testId="issues-band-chart"
          rows={bars}
          series={SERIES.map((s) => ({ key: s, label: t(`issues.band.${s}`), fill: toneFill(TONES[s]) }))}
          tipOf={(d) => [d.label, `${t("issues.band.opened")} ${d.opened}`, `${t("issues.band.closed")} ${d.closed}`]}
          emptyText={t("issues.band.none")}
          reader={{ head: [t("issues.band.day"), t("issues.band.opened"), t("issues.band.closed")], rows: bars.map((d) => [d.label, d.opened, d.closed]) }}
        />
        ) : null
      }
    />
  );
}
