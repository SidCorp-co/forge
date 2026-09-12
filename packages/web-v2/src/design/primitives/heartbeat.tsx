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
// cm:guard an all-zero window draws a FLATLINE and never an empty frame: "nothing ran for thirty days" is the single most important thing this surface says, and a figure that renders nothing when its series is all zeros hides exactly the state it exists to show (ISS-988 criterion 26).
// cm:guard no door, so no `<button>`, no `tabIndex` and no cursor — a day is a date-windowed aggregate this response cannot list the records behind, and an affordance that opens nothing is worse than no affordance (ISS-988 criteria 42-44).
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
