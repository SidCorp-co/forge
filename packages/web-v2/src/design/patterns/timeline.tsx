// A list whose rows are lanes on one time axis (ISS-979, the owner's mockup v3): a column header (the
// lead's name, the axis with a label at each tick and "now", and the trailing columns), then each
// group's `GroupHeader` with its lanes indented under it. A lane is its lead (a name and one line), a
// track and two trailing cells. The track draws light gridlines at each tick, a base line, runs as
// light bars (a live one solid) and the marks a page places on it (`TimelineMark`), up to a dashed
// "now" edge. The lanes keep a floor width and scroll sideways inside their own scroller below it, so
// the page never does; on a phone the side columns step down.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { GROUP_ROW_INDENT } from "./group-header";

/** One grid for the column header and every lane: lead · track · two trailing cells. */
const LANE_COLS = "grid grid-cols-[214px_minmax(0,1fr)_92px_100px] items-center max-md:grid-cols-[140px_minmax(0,1fr)_70px_80px]";
const CELL = "min-w-0 px-4 max-md:px-2.5";
/**
 * On a phone the lanes scroll sideways under their names: the name column stays put, above the marks,
 * with an edge, so a tick label or mark passing under it reads as covered by the column, not cut (".6:00").
 */
const STICKY_LEAD = "max-md:sticky max-md:left-0 max-md:z-[4] max-md:self-stretch max-md:justify-center max-md:border-r max-md:border-line-divider";

const clamp = (n: number) => Math.min(100, Math.max(0, n));
const left = (at: number) => ({ left: `${clamp(at)}%` });

/** The lanes' frame: their own sideways scroller over a floor width, so the page itself never scrolls sideways. */
/** A group header inside the frame: on a phone it stays put, the frame's own width, while the lanes scroll under it. */
export const TIMELINE_GROUP_STICKY = "max-md:sticky max-md:left-0 max-md:w-[100cqw]";

export function TimelineFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="@container/frame overflow-x-auto" data-testid="timeline-frame">
      <div className="min-w-[900px]">{children}</div>
    </section>
  );
}

/** The column header: the lead's name, the axis (a label at each tick, "now" at its end), the trailing names. */
export function TimelineHead({ lead, ticks, now, trail }: { lead: string; ticks: { key: string; at: number; text: string }[]; now: string; trail: [string, string] }) {
  return (
    <div className={cn(LANE_COLS, "min-h-[34px] border-b border-line-divider bg-sunken text-12 text-subtle")} data-testid="timeline-axis">
      <span className={cn(CELL, STICKY_LEAD, "max-md:bg-sunken")}>{lead}</span>
      <span className={cn(CELL, "relative h-[34px]")}>
        <span className="absolute inset-y-0 right-4 left-4 max-md:right-2.5 max-md:left-2.5">
          {ticks.map((t) => (
            <span key={t.key} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-11 tabular-nums" style={left(t.at)}>
              {t.text}
            </span>
          ))}
          <span className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 text-11 font-semibold text-muted">{now}</span>
        </span>
      </span>
      <span className={cn(CELL, "text-right")}>{trail[0]}</span>
      <span className={cn(CELL, "text-right")}>{trail[1]}</span>
    </div>
  );
}

/** A run on a track: a light bar from `from` to `to` (percentages), solid while it still runs. */
export interface TimelineRun {
  key: string;
  from: number;
  to: number;
  live: boolean;
  /** Its time, on hover. */
  title: string;
}

/** One lane's track: gridlines at `ticks`, the base line, its runs, the marks a page places, the dashed now edge. */
export function TimelineTrack({ ticks, runs, children }: { ticks: number[]; runs: TimelineRun[]; children?: ReactNode }) {
  return (
    <span className="relative block h-8 min-w-0" data-testid="timeline-track">
      {ticks.map((t) => (
        <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-line-divider" style={left(t)} />
      ))}
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-divider" />
      {runs.map((r) => (
        <span
          key={r.key}
          title={r.title}
          className={cn("absolute top-1/2 -mt-[3px] h-1.5 rounded-[3px]", r.live ? "bg-info-9" : "bg-info-6")}
          style={{ left: `${clamp(r.from)}%`, right: `${100 - clamp(r.to)}%`, minWidth: 3 }}
          data-testid="timeline-run"
          data-live={r.live || undefined}
        />
      ))}
      {children}
      <span aria-hidden className="absolute inset-y-0.5 right-0 border-l border-dashed border-line-strong" />
    </span>
  );
}

/** What a mark on a track looks like: a numbered circle, a diamond in a state's tone, or an amber pin with its count. */
export type TimelineMarkShape =
  | { kind: "count"; n: number }
  | { kind: "diamond"; tone: "ok" | "info" | "danger" | "neutral" }
  | { kind: "pin"; n: number };

const DIAMOND: Record<"ok" | "info" | "danger" | "neutral", string> = { ok: "bg-ok-9", info: "bg-info-9", danger: "bg-danger-9", neutral: "bg-neutral-8" };

/** A mark's look alone, for the legend and the track. */
export function TimelineGlyph({ shape, small = false }: { shape: TimelineMarkShape; small?: boolean }) {
  if (shape.kind === "count") {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full border-[1.5px] border-current bg-surface font-semibold leading-none text-muted tabular-nums",
          small ? "h-4 min-w-[18px] px-1 text-[10px]" : "h-5 min-w-5 px-[5px] text-11",
        )}
      >
        {shape.n}
      </span>
    );
  }
  if (shape.kind === "diamond") {
    return <span className={cn("inline-block rotate-45", small ? "size-2.5 rounded-[1px]" : "size-3.5 rounded-[2px]", DIAMOND[shape.tone])} />;
  }
  return (
    <span className={cn("inline-flex -rotate-45 items-center justify-center rounded-[50%_50%_50%_0] bg-warn-9", small ? "size-3" : "size-[22px]")}>
      {small ? null : (
        <span className="rotate-45 text-11 font-semibold leading-none" style={{ color: "var(--on-warn)" }}>
          {shape.n}
        </span>
      )}
    </span>
  );
}

/**
 * A mark placed on a track at `at` (a percentage), a button: its summary on hover and on keyboard
 * focus (`label`, also its accessible name), and what it opens on click is the page's. A pin stands
 * on its point, above the line; the others are centred on it, or hang just below it where `lowered`,
 * so a mark that would sit on another stays in reach (`spreadMarks`). Once its popover closes, the
 * mark keeps focus but shows no summary until it is left or blurred, so no two summaries stand at once.
 */
export function TimelineMark({
  at,
  shape,
  label,
  onOpen,
  open,
  markRef,
  testId,
  lowered = false,
  shift = 0,
}: {
  at: number;
  lowered?: boolean;
  /** Steps aside from `at` by this many px, so a crowded run of marks keeps each its own spot (`spreadMarks`). */
  shift?: number;
  shape: TimelineMarkShape;
  label: string;
  onOpen: () => void;
  open: boolean;
  markRef?: (el: HTMLButtonElement | null) => void;
  testId: string;
}) {
  const [quiet, setQuiet] = useState(false);
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) setQuiet(true);
    wasOpenRef.current = open;
  }, [open]);
  return (
    <button
      ref={markRef}
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        "group/mark absolute z-[2] flex cursor-pointer items-center justify-center rounded-full outline-none hover:z-[3] hover:brightness-105 focus-visible:z-[3] focus-visible:shadow-focus",
        shape.kind === "pin"
          ? "top-[calc(50%+2px)] -translate-x-1/2 -translate-y-full"
          : lowered
            ? "top-[calc(50%+3px)] -translate-x-1/2"
            : "top-1/2 -translate-x-1/2 -translate-y-1/2",
      )}
      style={{ left: `calc(${clamp(at)}% + ${shift}px)` }}
      data-testid={testId}
      data-lowered={lowered ? "" : undefined}
      data-shift={shift === 0 ? undefined : shift}
      // a mark whose popover just closed (Escape gives it focus back) stays quiet until the pointer comes
      // back to it, so hovering a neighbour never shows two summaries at once
      onPointerEnter={() => setQuiet(false)}
    >
      <TimelineGlyph shape={shape} />
      {open || quiet ? null : (
        // the summary on hover and on keyboard focus; out of the layout until then, so it never widens the lanes' scroller
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-full mb-1.5 hidden whitespace-nowrap rounded-md bg-fg px-2 py-1 text-12 font-normal text-surface group-hover/mark:block group-focus-visible/mark:block",
            at > 70 ? "right-0" : at < 20 ? "left-0" : "left-1/2 -translate-x-1/2",
          )}
          data-testid="timeline-tip"
        >
          {label}
        </span>
      )}
    </button>
  );
}

/**
 * How near two marks may stand, in percent of the track, before one would cover the other: a mark is
 * at most 22px across, and the lanes' floor width leaves the track about 590px, so 3.8% is the widest
 * a mark spans on the narrowest track.
 */
export const MARK_GAP = 3.8;

/** How far apart two marks stand once spread, in px: a mark's width and a gap. */
export const MARK_STEP = 24;

/** The narrowest a lane's track gets: the lanes' floor width leaves it about this many px, and narrower screens scroll it. */
export const TRACK_FLOOR_PX = 590;

/** {@link MARK_STEP} in percent of the narrowest track: two marks this far apart never touch at any width. */
const STEP_PCT = (MARK_STEP / TRACK_FLOOR_PX) * 100;

/** Where a mark stands once spread: hung below the line under a pin, and stepped aside in px. */
export interface MarkSpot {
  lowered: boolean;
  shift: number;
}

/**
 * Where each mark stands so none covers another. Pins stand above the line and never move. Every
 * other mark of the lane is packed in time order: each stands at least {@link MARK_STEP} px past the
 * one before it on the narrowest track, and marks that would pass the now edge are packed back
 * leftwards from it. A mark's `shift` is that move in px on the narrowest track; on a wider one the
 * distance between neighbours only grows, so no two marks touch at any width, and a crowd never steps
 * onto a neighbour outside it. A mark that ends within `gap` of a pin hangs just below the line.
 * Keyed by the marks' keys.
 */
export function spreadMarks(
  marks: readonly { key: string; at: number; pin: boolean }[],
  gap: number = MARK_GAP,
): Map<string, MarkSpot> {
  const pins = marks.filter((m) => m.pin).map((m) => m.at);
  const spots = new Map<string, MarkSpot>(marks.filter((m) => m.pin).map((m) => [m.key, { lowered: false, shift: 0 }]));
  const line = [...marks].filter((m) => !m.pin).sort((a, b) => a.at - b.at);
  const placed = line.map((m) => m.at);
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + STEP_PCT);
  for (let i = placed.length - 1; i >= 0; i--) {
    const room = i === placed.length - 1 ? 100 : placed[i + 1] - STEP_PCT;
    placed[i] = Math.min(placed[i], room);
  }
  line.forEach((m, i) => {
    const at = placed[i];
    // whole px, and `|| 0` so a mark that stays put reads 0, never -0
    const shift = Math.round(((at - m.at) * TRACK_FLOOR_PX) / 100) || 0;
    spots.set(m.key, { lowered: pins.some((p) => Math.abs(p - at) < gap), shift });
  });
  return spots;
}

/** What each mark means: one swatch and a short label each. */
export function TimelineLegend({ items }: { items: { key: string; swatch: ReactNode; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 border-b border-line-divider px-5 py-2.5 text-12 text-subtle max-md:px-4" data-testid="timeline-legend">
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1.5" data-testid={`legend-${i.key}`}>
          <span aria-hidden className="inline-flex">
            {i.swatch}
          </span>
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** A run's swatch for the legend. */
export function TimelineRunSwatch() {
  return <i className="inline-block h-1.5 w-[18px] rounded-[3px] bg-info-6" />;
}

/** One lane, indented under its group's label: its lead, its track and its two trailing cells. */
export function TimelineRow({ rowKey, selected, lead, track, you, last }: { rowKey: string; selected: boolean; lead: ReactNode; track: ReactNode; you: ReactNode; last: ReactNode }) {
  return (
    <div
      aria-current={selected ? "true" : undefined}
      data-testid="list-row"
      data-key={rowKey}
      className={cn(
        LANE_COLS,
        "relative min-h-[52px] border-b border-line-divider text-fg",
        selected && "bg-sel before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-link",
      )}
    >
      <span className={cn(CELL, GROUP_ROW_INDENT, STICKY_LEAD, selected ? "max-md:bg-sel" : "max-md:bg-surface", "flex flex-col py-1.5 max-md:pl-8")}>{lead}</span>
      <span className={CELL}>{track}</span>
      <span className={cn(CELL, "flex justify-end")}>{you}</span>
      <span className={cn(CELL, "text-right text-12 text-subtle")}>{last}</span>
    </div>
  );
}
