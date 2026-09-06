import { cn } from "@/lib/utils/cn";

export interface SparklineProps {
  /** Oldest → newest. Fewer than two points renders nothing. */
  points: number[];
  width?: number;
  height?: number;
  /** Any CSS colour; defaults to the muted foreground so the number leads. */
  stroke?: string;
  className?: string;
}

/** Trend shape beside a value it does not replace: no axes, no labels, no
    tooltip. `aria-hidden` because the value and its delta are already text —
    a screen reader gains nothing from 24 unlabelled numbers, and the series
    carries no datum the caller has not already written out. */
export function Sparkline({
  points,
  width = 72,
  height = 20,
  stroke = "var(--fg-subtle)",
  className,
}: SparklineProps) {
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  // cm:why a flat series has span 0, and dividing by it puts every point at NaN — draw it down the middle instead, which is what "no movement" looks like
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = 1.5;
  const usable = height - pad * 2;

  const d = points
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (pad + usable - ((v - min) / span) * usable).toFixed(2);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
