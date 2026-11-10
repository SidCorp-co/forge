// The Agents page's overview (REQ-43 r3 BC-14..BC-17): runs started and finished over the last days,
// the flow of the listed runs by core's attention group each with its count, toned as its group's
// heading, and runs started against finished per day in the reader's days (`runs/flow`, one small
// read beside the list). The flow counts the very runs the groups under it hold (L-57); the scope
// switch's live and finished counts stay the toolbar's and are not said again here.

import { RUN_FLOW_DAYS, type RunFlowDay } from "@forge/contracts/run-flow";
import { RUN_GROUP_LABELS, RUN_GROUPS } from "@forge/contracts/run-standing";
import { BarChartFigure, dayLabel, dayTick, OverviewBand, pairCaps, toneFill } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useRunFlow } from "../hooks";
import type { RunStanding } from "../types";
import { attentionGroupText } from "../view";

const SERIES = ["started", "finished"] as const;
/** A run starting reads as running, a run ending as done. */
const TONES = { started: "run", finished: "done" } as const;

/** Each day's bars, the highest and today's value of each series printed on its own row, one per day. */
export function runBarsOf(days: readonly RunFlowDay[]) {
  const caps = pairCaps(days, "started", "finished");
  return days.map((d, i) => ({ ...d, label: dayLabel(d.day), tick: dayTick(d.day), ...caps[i] }));
}

export function RunsBand({ projectId, rows }: { projectId: string; rows: readonly RunStanding[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const flow = useRunFlow(projectId).data;
  const bars = runBarsOf(flow?.days ?? []);
  const sum = (k: (typeof SERIES)[number]) => (flow ? bars.reduce((n, d) => n + d[k], 0) : "–");
  return (
    <OverviewBand
      label={t("agents.band.label")}
      testId="runs-band"
      figures={[
        { key: "started", value: sum("started"), label: t("agents.band.startedIn", { n: RUN_FLOW_DAYS }) },
        { key: "finished", value: sum("finished"), label: t("agents.band.finishedIn", { n: RUN_FLOW_DAYS }) },
      ]}
      flow={RUN_GROUPS.map((g) => ({ key: g, label: attentionGroupText(g, language).label, count: rows.filter((r) => r.attentionGroup === g).length, tone: RUN_GROUP_LABELS[g].tone }))}
      chart={
        flow ? (
          <BarChartFigure
            title={t("agents.band.chart")}
            testId="runs-band-chart"
            rows={bars}
            series={SERIES.map((s) => ({ key: s, label: t(`agents.band.${s}`), fill: toneFill(TONES[s]) }))}
            tipOf={(d) => [d.label, `${t("agents.band.started")} ${d.started}`, `${t("agents.band.finished")} ${d.finished}`]}
            emptyText={t("agents.band.none")}
            reader={{ head: [t("agents.band.day"), t("agents.band.started"), t("agents.band.finished")], rows: bars.map((d) => [d.label, d.started, d.finished]) }}
          />
        ) : null
      }
    />
  );
}
