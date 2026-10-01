"use client";

import { Line, LineChart, YAxis } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils/cn";

export interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
}

export function Sparkline({
  points,
  width = 72,
  height = 20,
  stroke = "var(--fg-subtle)",
  className,
}: SparklineProps) {
  if (points.length < 2) return null;
  const config: ChartConfig = { value: { label: "Value", color: stroke } };
  const data = points.map((value, i) => ({ i, value }));
  return (
    <ChartContainer
      aria-hidden
      config={config}
      initialDimension={{ width, height }}
      className={cn("aspect-auto shrink-0", className)}
      style={{ width, height }}
    >
      <LineChart data={data} margin={{ top: 1.5, right: 1, bottom: 1.5, left: 1 }} accessibilityLayer={false}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line
          dataKey="value"
          type="linear"
          stroke="var(--color-value)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
