// The capabilities page's overview (ISS-1251 §7): calls over the window, how many doors are taught,
// how many no agent called, and how many piles are over their cap; the doors by where they stand; and
// calls against refusals per day, so a reader sees whether use moves before the list.

import type { DoorUseDay, DoorUseView } from "@forge/contracts/door-use";
import { BarChartFigure, dayLabel, dayTick, OverviewBand, pairCaps, toneFill } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { CAP_STANDING_TONE, CAP_STANDINGS, type CapStanding } from "../capabilities";

const SERIES = ["calls", "refused"] as const;
const TONES = { calls: "run", refused: "err" } as const;

/** Each day's bars, the highest and today's value of each series printed on its own row. */
export function callBarsOf(days: readonly DoorUseDay[]) {
  const caps = pairCaps(days, "calls", "refused");
  return days.map((d, i) => ({ ...d, label: dayLabel(d.day), tick: dayTick(d.day), ...caps[i] }));
}

interface CapabilitiesBandProps {
  use: DoorUseView;
  counts: Record<CapStanding, number>;
  /** Piles over their cap, or null while the piles read has not answered. */
  over: number | null;
}

export function CapabilitiesBand({ use, counts, over }: CapabilitiesBandProps) {
  const t = useCopy();
  const bars = callBarsOf(use.days);
  const { doors, taught, calls } = use.totals;
  return (
    <OverviewBand
      label={t("modules.cap.band.label")}
      testId="capabilities-band"
      figures={[
        { key: "calls", value: calls, label: t("modules.cap.band.callsIn", { n: use.window.days }) },
        { key: "taught", value: `${taught}/${doors}`, label: t("modules.cap.band.taught"), ring: doors > 0 ? taught / doors : 0 },
        // the figure is its flow step's count: a door owing a re-check stands there, called or not
        { key: "unused", value: counts.unused, label: t("modules.cap.band.unused") },
        { key: "over", value: over ?? "–", label: t("modules.cap.band.over") },
      ]}
      flow={CAP_STANDINGS.map((s) => ({ key: s, label: t(`modules.cap.standing.${s}`), count: counts[s], tone: CAP_STANDING_TONE[s] }))}
      chart={
        <BarChartFigure
          title={t("modules.cap.band.chart")}
          testId="capabilities-band-chart"
          rows={bars}
          series={SERIES.map((s) => ({ key: s, label: t(`modules.cap.band.${s}`), fill: toneFill(TONES[s]) }))}
          tipOf={(d) => [d.label, `${t("modules.cap.band.calls")} ${d.calls}`, `${t("modules.cap.band.refused")} ${d.refused}`]}
          emptyText={t("modules.cap.band.none")}
          reader={{ head: [t("agents.band.day"), t("modules.cap.band.calls"), t("modules.cap.band.refused")], rows: bars.map((d) => [d.label, d.calls, d.refused]) }}
        />
      }
    />
  );
}
