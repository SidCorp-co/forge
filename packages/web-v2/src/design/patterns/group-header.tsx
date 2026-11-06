// A group's header in any grouped list (owner ruling 2026-11-05, design README Grouping, ISS-979): the
// grouping reads as a hierarchy, flat. The header is set apart by type and colour, never by a box or a
// tinted band: a dot in the group's tone, a larger semibold full-contrast label (a group that needs the
// person takes its amber), and its count as a small pill. The fold is a thin chevron after the count,
// shown on hover or keyboard focus and while the group is folded, never a filled triangle before the
// label. The rows under it are indented to the label: `GROUP_ROW_INDENT`.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

/** The left padding of every row under a group header: its first column starts under the header's label (32px). */
export const GROUP_ROW_INDENT = "pl-8";

const needsPerson = (t: LegendTone | null | undefined) => t === "you";

export function GroupHeader({
  id,
  label,
  count,
  tone,
  open,
  onToggle,
  mono = false,
  after,
  className,
}: {
  id: string;
  label: ReactNode;
  count: number;
  tone?: LegendTone | null;
  open: boolean;
  onToggle: () => void;
  /** A label drawn in mono, for a code path such as a module. */
  mono?: boolean;
  /** What follows the chevron: a group's label-first counts. */
  after?: ReactNode;
  /** Where the header sticks, under the list's own column header. */
  className?: string;
}) {
  const you = needsPerson(tone);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid="list-group"
      data-group={id}
      className={cn(
        "group/header z-[5] flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line-divider bg-app pt-4 pr-5 pb-2 pl-4 text-left text-14 font-semibold text-fg outline-none focus-visible:shadow-focus",
        className,
      )}
    >
      <i aria-hidden className="inline-block size-2 flex-none rounded-full" data-testid="group-dot" style={{ background: LEGEND[tone ?? "neutral"].dot }} />
      <span className={cn(mono && "font-mono text-13")} style={you ? { color: LEGEND.you.fg } : undefined} data-testid="group-label">
        {label}
      </span>
      <span
        className="inline-flex h-[18px] min-w-5 items-center justify-center rounded-full px-1.5 text-12 font-semibold tabular-nums"
        style={you ? { background: LEGEND.you.bg, color: LEGEND.you.fg } : { background: "var(--bg-sunken)", color: "var(--fg-muted)" }}
        data-testid="group-count"
      >
        {count}
      </span>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-testid="group-chevron"
        className={cn(
          "ml-0.5 size-3.5 text-subtle transition-[opacity,transform] duration-150",
          open ? "opacity-0 group-hover/header:opacity-100 group-focus-visible/header:opacity-100" : "-rotate-90 opacity-100",
        )}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
      {after}
    </button>
  );
}
