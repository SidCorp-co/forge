"use client";

import { cellText, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { type ChartModel, chartModel } from "./chart-model";
import { useBlockInstants } from "./instants";
import { TextAlternative } from "./text-alternative";
import { UnsupportedBlock } from "./unsupported";

/** The five chart tokens, which the theme defines for light and dark; a sixth series wraps round. */
const COLOUR = (i: number) => `var(--chart-${(i % 5) + 1})`;

const TICK = { fill: "var(--fg-muted)", fontSize: 11 } as const;
const AXIS_NAME = { fill: "var(--fg-subtle)", fontSize: 11 } as const;
const AXIS = { stroke: "var(--border-strong)" } as const;
const MARGIN = { top: 8, right: 12, bottom: 22, left: 8 };
const TIP = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--fg-default)",
  fontSize: 12,
} as const;

function Legend({ model }: { model: ChartModel }) {
  if (model.series.length < 2) return null;
  return (
    <ul className="m-0 mb-1 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11.5px] text-muted" data-testid="chart-legend">
      {model.series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-[3px] w-3 rounded-full" style={{ background: COLOUR(i) }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** A bar, line or burndown chart: each row of the frame is a point, each value an unscaled number from its cell. */
export function ChartBlockView({ block }: { block: VisualBlockOf<"chart"> }) {
  const instants = useBlockInstants();
  const model = chartModel(block, instants);
  if ("unsupported" in model) {
    return (
      <>
        <UnsupportedBlock kind="chart" reason={model.unsupported} />
        <TextAlternative block={block} />
      </>
    );
  }
  const config: ChartConfig = Object.fromEntries(
    model.series.map((s, i) => [s.key, { label: s.name, color: COLOUR(i) }]),
  );
  const data = model.points.map((p, i) => ({
    at: p.at,
    label: p.label,
    ...Object.fromEntries(model.series.map((s) => [s.key, s.values[i]])),
  }));
  const yTick = (v: number) => (model.yField.type === "duration" ? cellText(model.yField, v) : String(v));
  const xAxis =
    model.scale === "category" ? (
      <XAxis dataKey="label" tickLine={false} axisLine={AXIS} tick={TICK} interval="preserveStartEnd" label={{ value: model.xLabel, position: "insideBottom", offset: -14, ...AXIS_NAME }} />
    ) : (
      <XAxis
        dataKey="at"
        type="number"
        scale={model.scale === "time" ? "time" : "linear"}
        domain={[model.xTicks?.[0] ?? "dataMin", model.xTicks?.[model.xTicks.length - 1] ?? "dataMax"]}
        ticks={model.xTicks ?? undefined}
        tickFormatter={(v: number) => (model.scale === "time" ? instants.day(new Date(v).toISOString()) : String(v))}
        tickLine={false}
        axisLine={AXIS} tick={TICK}
        label={{ value: model.xLabel, position: "insideBottom", offset: -14, ...AXIS_NAME }}
      />
    );
  const yAxis = (
    <YAxis
      type="number"
      domain={model.domain}
      ticks={model.yTicks}
      tickFormatter={yTick}
      tickLine={false}
      axisLine={AXIS} tick={TICK}
      width={model.yLabel ? 56 : 40}
      {...(model.yLabel ? { label: { value: model.yLabel, angle: -90, position: "insideLeft", offset: 4, ...AXIS_NAME } } : {})}
    />
  );
  const common = { data, margin: MARGIN, accessibilityLayer: false } as const;
  const tip = <Tooltip contentStyle={TIP} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ""} />;
  return (
    <div className="min-w-0" data-testid="chart-block" data-variant={model.variant} data-scale={model.scale}>
      <Legend model={model} />
      <div aria-hidden>
        <ChartContainer config={config} className="aspect-auto h-[240px] w-full" initialDimension={{ width: 480, height: 240 }}>
          {model.variant === "bar" ? (
            <BarChart {...common}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              {xAxis}
              {yAxis}
              {tip}
              {model.series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={`var(--color-${s.key})`} isAnimationActive={false} />
              ))}
            </BarChart>
          ) : (
            <LineChart {...common}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              {xAxis}
              {yAxis}
              {tip}
              {model.series.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.name}
                  type="linear"
                  stroke={`var(--color-${s.key})`}
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      </div>
      <TextAlternative block={block} />
    </div>
  );
}
