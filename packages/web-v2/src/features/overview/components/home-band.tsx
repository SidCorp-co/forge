// The workspace home's overview (REQ-43 r3 BC-14..BC-17): how many of the person's requests are
// moving and how many a run works on now, the flow of the listed requests by stage each with its count
// in the tone its row's chip wears, and on which of the last days each last moved, in the reader's days.
// All of it is counted over the very rows the list under it holds (L-57): the home's one read.

import { HOME_STAGES } from "@forge/contracts/owner-home";
import { PROJECT_HOME_DAYS } from "@forge/contracts/project-home";
import { BarChartFigure, dayCountsOf, OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { STAGE_TONE } from "../home-rows";
import type { HomeMovingItem } from "../types";

export function HomeBand({ items, total }: { items: readonly HomeMovingItem[]; total: number }) {
  const t = useCopy();
  const days = dayCountsOf(items.map((m) => m.lastMovedAt), PROJECT_HOME_DAYS);
  return (
    <OverviewBand
      label={t("overview.home.band.label")}
      testId="home-band"
      figures={[
        { key: "moving", value: total, label: t("overview.home.band.moving") },
        { key: "running", value: items.filter((m) => m.running).length, label: t("overview.home.runningNow") },
      ]}
      flow={HOME_STAGES.map((s) => ({ key: s, label: t(`overview.home.stage.${s}`), count: items.filter((m) => m.stage === s).length, tone: STAGE_TONE[s] }))}
      chart={
        <BarChartFigure
          title={t("overview.home.band.chart")}
          testId="home-band-chart"
          rows={days}
          series={[{ key: "count", label: t("overview.home.band.moved"), fill: "var(--chart-2)" }]}
          tipOf={(d) => [d.label, t("overview.home.band.tip", { n: d.count })]}
          emptyText={t("overview.home.band.none")}
          reader={{ head: [t("overview.home.band.day"), t("overview.home.band.moved")], rows: days.map((d) => [d.label, d.count]) }}
        />
      }
    />
  );
}
