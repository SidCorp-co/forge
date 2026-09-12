import { cn } from "@/lib/utils/cn";

export interface StreamWeek {
  key: string;
  /** Drawn upward. */
  inbound: number;
  /** Drawn downward. */
  outbound: number;
  /** The line across the band. */
  line: number;
}

export interface StreamBandProps {
  weeks: StreamWeek[];
  inboundLabel: string;
  outboundLabel: string;
  lineLabel: string;
  /** Sentence a reader who cannot see the band gets instead. */
  label: string;
  className?: string;
}

/**
 * Two opposing series about a midline, with a third drawn across them.
 */
// cm:guard both series share ONE scale, so the taller of the two sets it: scaling each half to its own maximum draws a week that created 40 and closed 4 as two equal blocks, which is the inverse of what the figure is for (ISS-988 criterion 36).
// cm:guard no door — a week is a date-windowed aggregate no client-reachable route can list, so nothing here is focusable and nothing carries a cursor (ISS-988 criteria 42-44).
export function StreamBand({
  weeks,
  inboundLabel,
  outboundLabel,
  lineLabel,
  label,
  className,
}: StreamBandProps) {
  if (weeks.length === 0) return null;

  const width = 640;
  const height = 120;
  const mid = height / 2;
  const maxBar = Math.max(1, ...weeks.map((w) => Math.max(w.inbound, w.outbound)));
  const maxLine = Math.max(1, ...weeks.map((w) => w.line));
  const slot = width / weeks.length;
  const barW = Math.max(2, slot * 0.55);

  const linePath = weeks
    .map((w, i) => {
      const x = i * slot + slot / 2;
      const y = height - (w.line / maxLine) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <figure className={cn("m-0 flex w-full flex-col gap-2", className)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-32 w-full"
      >
        <title>{label}</title>
        {weeks.map((w, i) => {
          const x = i * slot + (slot - barW) / 2;
          const up = (w.inbound / maxBar) * (mid - 2);
          const down = (w.outbound / maxBar) * (mid - 2);
          return (
            <g key={w.key}>
              <rect
                x={x}
                y={mid - up}
                width={barW}
                height={up}
                fill="var(--accent)"
                opacity={0.85}
              />
              <rect
                x={x}
                y={mid}
                width={barW}
                height={down}
                fill="var(--green-500)"
                opacity={0.85}
              />
            </g>
          );
        })}
        <line x1={0} y1={mid} x2={width} y2={mid} stroke="var(--border-default)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--fg-default)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        <li className="fg-body-sm flex items-center gap-1.5 text-muted">
          <span aria-hidden className="size-2 rounded-[2px] bg-accent" />
          {inboundLabel}
        </li>
        <li className="fg-body-sm flex items-center gap-1.5 text-muted">
          <span aria-hidden className="size-2 rounded-[2px] bg-green" />
          {outboundLabel}
        </li>
        <li className="fg-body-sm flex items-center gap-1.5 text-muted">
          <span aria-hidden className="h-0 w-3 border-t border-dashed border-fg" />
          {lineLabel}
        </li>
      </ul>
    </figure>
  );
}
