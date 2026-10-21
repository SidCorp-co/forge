import { useId } from "react";
import { cn } from "@/lib/utils/cn";

/** The fewest issues a full bar or the line's top stands for, so one issue never fills the band. */
export const STREAM_SCALE_FLOOR = 4;
/** Inset that keeps the line off the band's edges. */
const LINE_INSET = 8;

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
export function StreamBand({
  weeks,
  inboundLabel,
  outboundLabel,
  lineLabel,
  label,
  className,
}: StreamBandProps) {
  const clip = useId();
  if (weeks.length === 0) return null;

  const width = 640;
  const height = 120;
  const mid = height / 2;
  const maxBar = Math.max(STREAM_SCALE_FLOOR, ...weeks.map((w) => Math.max(w.inbound, w.outbound)));
  const maxLine = Math.max(STREAM_SCALE_FLOOR, ...weeks.map((w) => w.line));
  const slot = width / weeks.length;
  const barW = Math.max(2, Math.min(slot * 0.55, 24));

  const linePath = weeks
    .map((w, i) => {
      const x = i * slot + slot / 2;
      const y = height - LINE_INSET - (w.line / maxLine) * (height - 2 * LINE_INSET);
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
        <defs>
          <clipPath id={clip}>
            <rect x={0} y={0} width={width} height={height} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clip})`} data-stream-plot>
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
        </g>
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        <li className="fg-body-sm flex items-center gap-1.5 text-muted">
          <span aria-hidden className="size-2 rounded-2 bg-accent" />
          {inboundLabel}
        </li>
        <li className="fg-body-sm flex items-center gap-1.5 text-muted">
          <span aria-hidden className="size-2 rounded-2 bg-green" />
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
