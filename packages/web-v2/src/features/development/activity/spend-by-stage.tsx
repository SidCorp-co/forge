"use client";

// Seven days of spend by stage (ISS-379, AC#4): one stacked Recharts bar in the shared
// ChartContainer, its legend under it, and what is in flight now. The trend over time waits on
// ISS-380's bucketed reads and says so.

import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, Section } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { ChartLegend } from "./chart-legend";
import type { SpendByStageData } from "./derive";
import { formatUsd } from "@/lib/i18n/format";

export function SpendByStage({ data, inFlightUsd }: { data: SpendByStageData; inFlightUsd: number }) {
  const { segments, total } = data;
  const t = useCopy();
  const config: ChartConfig = Object.fromEntries(segments.map((s) => [s.key, { label: t(`overview.spend.${s.key}`), color: s.color }]));
  const row = [Object.fromEntries(segments.map((s) => [s.key, s.cost]))];
  return (
    <Section title={t("overview.spend.title")} right={<span className="font-mono text-13 font-semibold tabular-nums text-fg">{formatUsd(total)}</span>}>
      {total === 0 ? (
        <p className="py-6 text-center text-13 text-muted">{t("overview.spend.empty")}</p>
      ) : (
        <>
          <ChartContainer config={config} className="aspect-auto h-3 w-full" initialDimension={{ width: 320, height: 12 }}>
            <BarChart data={row} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
              <XAxis type="number" hide domain={[0, total]} />
              <YAxis type="category" hide />
              {segments.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="spend" fill={`var(--color-${s.key})`} isAnimationActive={false} />
              ))}
            </BarChart>
          </ChartContainer>
          <div className="mt-3 flex">
            <ChartLegend columns={2} rows={segments.map((s) => ({ key: s.key, color: s.color, label: t(`overview.spend.${s.key}`), value: formatUsd(s.cost) }))} />
          </div>
        </>
      )}
      <p className="mt-3 border-t border-line-subtle pt-2.5 text-12 text-subtle">
        {inFlightUsd > 0 ? `${t("overview.kpi.inFlight", { usd: formatUsd(inFlightUsd) })} · ` : ""}
        {t("overview.spend.trendSoon")}
      </p>
    </Section>
  );
}
