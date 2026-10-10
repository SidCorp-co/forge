
// Open issues by status (ISS-379, AC#4): a Recharts ring in the shared ChartContainer, its legend
// beside it. The colours are the legend tones the segments carry.

import { Cell, Pie, PieChart } from "recharts";
import { type ChartConfig, ChartContainer, Section } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { StatusDonutData } from "./derive";
import { ChartLegend } from "./chart-legend";

export function StatusDonut({ data }: { data: StatusDonutData }) {
  const { segments, total } = data;
  const t = useCopy();
  const config: ChartConfig = Object.fromEntries(segments.map((s) => [s.key, { label: t(`overview.donut.${s.key}`), color: s.color }]));
  return (
    <Section title={t("overview.donut.title")} right={<span className="font-mono text-13 font-semibold tabular-nums text-fg">{total}</span>}>
      {total === 0 ? (
        <p className="py-6 text-center text-13 text-muted">{t("overview.donut.empty")}</p>
      ) : (
        <div className="flex items-center gap-5">
          <ChartContainer config={config} className="aspect-square size-28 flex-none" role="img" aria-label={t("overview.donut.aria", { n: total })}>
            <PieChart>
              <Pie data={segments} dataKey="count" nameKey="key" innerRadius="62%" outerRadius="100%" strokeWidth={0} isAnimationActive={false}>
                {segments.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <ChartLegend rows={segments.map((s) => ({ key: s.key, color: s.color, label: t(`overview.donut.${s.key}`), value: String(s.count), share: `${Math.round(s.pct)}%` }))} />
        </div>
      )}
    </Section>
  );
}
