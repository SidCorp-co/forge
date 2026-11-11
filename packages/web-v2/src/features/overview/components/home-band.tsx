// The workspace home's overview (REQ-43 r3 BC-14..BC-17): how many of the person's requests are
// moving, how many rows wait on them, the flow of all of them by stage each with its count in the tone its row's chip wears, and on
// which of the last days the listed ones last moved, in the reader's days. The figure and the flow are
// core's counts over every moving request (`movingStages`), so the flow sums to the figure though the
// list under it holds the newest 50; no "running now" figure, which counts runs a direct build never starts.

import { HOME_STAGES, type HomeStage } from "@forge/contracts/owner-home";
import { PROJECT_HOME_DAYS } from "@forge/contracts/project-home";
import { BarChartFigure, dayCountsOf, OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { STAGE_TONE } from "../home-rows";
import type { HomeMovingItem } from "../types";

/**
 * `waiting` is what waits on the person across the workspace, core's Needs you count as Attention
 * serves it (`owedToYou`, ISS-1198 c3): their decisions and the rows owed beside them, such as a draft
 * of their own to propose; null while it is read.
 */
export function HomeBand({ items, total, stages, waiting }: { items: readonly HomeMovingItem[]; total: number; stages: Record<HomeStage, number>; waiting: number | null }) {
  const t = useCopy();
  const days = dayCountsOf(items.map((m) => m.lastMovedAt), PROJECT_HOME_DAYS);
  return (
    <OverviewBand
      label={t("overview.home.band.label")}
      testId="home-band"
      figures={[
        { key: "moving", value: total, label: t("overview.home.band.moving") },
        { key: "waiting", value: waiting ?? "…", label: t("overview.home.band.waiting") },
      ]}
      flow={HOME_STAGES.map((s) => ({ key: s, label: t(`overview.home.stage.${s}`), count: stages[s], tone: STAGE_TONE[s] }))}
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
