import { cn } from "@/lib/utils/cn";

export interface HeartbeatDay {
  date: string;
  value: number;
}

export interface HeartbeatProps {
  /** Oldest → newest, one entry per day of the window. */
  days: HeartbeatDay[];
  width?: number;
  height?: number;
  className?: string;
  /** Sentence a reader who cannot see the trace gets instead. */
  label: string;
}

/**
 * A day-by-day trace of how much the control plane executed.
 */
export function Heartbeat({
  days,
  width = 640,
  height = 56,
  className,
  label,
}: HeartbeatProps) {
  if (days.length === 0) return null;

  const max = Math.max(...days.map((d) => d.value));
  const pad = 3;
  const usable = height - pad * 2;
  const stepX = days.length > 1 ? width / (days.length - 1) : 0;
  const flat = max === 0;

  const y = (v: number) => (flat ? height / 2 : pad + usable - (v / max) * usable);
  const d = days
    .map((day, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)},${y(day.value).toFixed(2)}`)
    .join(" ");

  return (
    <figure className={cn("m-0 w-full", className)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-14 w-full"
      >
        <title>{label}</title>
        <path
          d={d}
          fill="none"
          stroke={flat ? "var(--fg-disabled)" : "var(--accent)"}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}
