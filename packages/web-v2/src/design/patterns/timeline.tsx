// A list whose rows are lanes on one time axis (ISS-951 round 3, MK-10 C): each row is a link that
// opens its peek like a list row, with its name and a short line on the left, a track in the middle and
// a mark on the right. The track draws bars (a stretch: something running, or waiting on a person),
// ticks (a moment something began) and dots (a moment something moved) at percentages of the axis,
// up to a dashed "now" edge. The track compresses as the list narrows (a peek beside it); the two side
// columns keep their width, and step down to a phone's at the page's md breakpoint.

import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";
import { LEGEND, type LegendTone } from "../vocabulary";

/** One grid for the axis and every lane: name · track · mark. */
const LANE_COLS =
  "grid grid-cols-[200px_minmax(0,1fr)_112px] items-center gap-x-3 px-5 max-md:grid-cols-[96px_minmax(0,1fr)_84px] max-md:gap-x-2 max-md:px-2.5";

/** What a bar means: `run` something running, `wait` stopped on a person. */
export type TimelineBarTone = "run" | "wait";
const BAR_TONE: Record<TimelineBarTone, string> = { run: "bg-info-9 opacity-85", wait: "bg-warn-9" };

/** A lane's marks, each at a percentage (0–100) of the axis. */
export interface TimelineMarks {
  bars: { key: string; from: number; to: number; tone: TimelineBarTone }[];
  ticks: { key: string; at: number }[];
  dots: { key: string; at: number }[];
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** One lane's track; `marks` null draws `empty` across it instead (a lane with nothing to draw). */
export function TimelineTrack({ marks, empty }: { marks: TimelineMarks | null; empty?: ReactNode }) {
  return (
    <span className="relative block h-[34px] min-w-0" data-testid="timeline-track">
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-divider" />
      {marks === null ? (
        <span className="absolute inset-0 flex items-center justify-center text-11-5 text-subtle" data-testid="timeline-empty">
          <span className="bg-surface px-1.5">{empty}</span>
        </span>
      ) : (
        <>
          {marks.bars.map((b) => (
            <span
              key={b.key}
              className={cn("absolute top-[11px] h-3 rounded-[2px]", BAR_TONE[b.tone])}
              style={{ left: `${clamp(b.from)}%`, right: `${100 - clamp(b.to)}%`, minWidth: 3 }}
              data-testid="timeline-bar"
              data-tone={b.tone}
            />
          ))}
          {marks.ticks.map((t) => (
            <span key={t.key} className="absolute top-[5px] h-6 w-0.5 -translate-x-1/2 bg-neutral-9" style={{ left: `${clamp(t.at)}%` }} data-testid="timeline-tick" />
          ))}
          {marks.dots.map((d) => (
            <span
              key={d.key}
              className="absolute top-1/2 box-content size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-surface bg-ok-9"
              style={{ left: `${clamp(d.at)}%` }}
              data-testid="timeline-dot"
            />
          ))}
        </>
      )}
      <span aria-hidden className="absolute inset-y-0.5 right-0 border-r-[1.5px] border-dashed border-fg" />
    </span>
  );
}

/** The axis over the lanes: each label at its percentage; a `minor` one is left out on a phone. */
export function TimelineAxis({ labels }: { labels: { key: string; at: number; text: string; minor?: boolean }[] }) {
  return (
    <div className={cn(LANE_COLS, "sticky top-0 z-[6] h-7 border-b border-line-divider bg-sunken text-11 text-subtle")} data-testid="timeline-axis" aria-hidden>
      <span />
      <span className="relative h-full font-mono">
        {labels.map((l) => (
          <span
            key={l.key}
            className={cn("absolute top-1/2 -translate-y-1/2 whitespace-nowrap", l.at <= 0 ? "" : l.at >= 100 ? "-translate-x-full" : "-translate-x-1/2", l.minor && "max-md:hidden")}
            style={{ left: `${clamp(l.at)}%` }}
          >
            {l.text}
          </span>
        ))}
      </span>
      <span />
    </div>
  );
}

/** What each mark means, one short label each. */
export function TimelineLegend({ run, tick, dot, wait }: { run: string; tick: string; dot: string; wait: string }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 py-2 text-12 text-muted max-md:px-2.5" data-testid="timeline-legend">
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block h-2 w-3.5 rounded-[2px] bg-info-9" />
        {run}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block h-3 w-0.5 bg-neutral-9" />
        {tick}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block size-2 rounded-full bg-ok-9" />
        {dot}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block h-2 w-3.5 rounded-[2px] bg-warn-9" />
        {wait}
      </span>
    </div>
  );
}

/** A group's sticky header under the axis, label first, folding its lanes. */
export function TimelineGroupHeader({ id, label, tone, count, open, onToggle }: { id: string; label: string; tone: LegendTone; count: number; open: boolean; onToggle: () => void }) {
  const color = tone === "neutral" || tone === "done" ? "var(--fg-muted)" : LEGEND[tone].fg;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid="list-group"
      data-group={id}
      className="sticky top-7 z-[5] flex min-h-[34px] w-full items-center gap-2 bg-sunken px-5 py-[5px] text-left text-13 max-md:px-2.5"
    >
      <Icon name="chevronDown" size={12} className={cn("text-subtle transition-transform duration-150", !open && "-rotate-90")} />
      <span className="font-bold" style={{ color }}>
        {label}
      </span>
      <span className="font-mono text-12 font-bold" style={{ color }}>
        {count}
      </span>
    </button>
  );
}

const modified = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

/** One lane: a link to its full page that a plain click opens in the peek, as a list row does. */
export function TimelineRow({
  rowKey,
  href,
  selected,
  onPeek,
  lead,
  track,
  trail,
}: {
  rowKey: string;
  href: string;
  selected: boolean;
  onPeek: (key: string) => void;
  lead: ReactNode;
  track: ReactNode;
  trail: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (modified(e)) return;
        e.preventDefault();
        onPeek(rowKey);
      }}
      aria-current={selected ? "true" : undefined}
      data-testid="list-row"
      data-key={rowKey}
      className={cn(
        LANE_COLS,
        "relative min-h-[54px] w-full cursor-pointer border-b border-line-divider py-2 text-left text-fg no-underline hover:bg-hover",
        selected && "bg-sel before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-link hover:bg-sel",
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">{lead}</span>
      {track}
      <span className="flex min-w-0 justify-end">{trail}</span>
    </a>
  );
}
