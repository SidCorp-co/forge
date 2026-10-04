"use client";

// The one way a fixed enum reaches the screen: a mark plus a sentence-case label, the raw value only
// in the tooltip. A state family (StatusBadge) wears its legend tone; any other family (EnumBadge:
// priority, category, kind, level) is neutral, so colour always means whose turn it is.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import {
  enumLabel,
  type EnumFamily,
  LEGEND,
  type LegendTone,
  PRIORITY_BARS,
  type StatusFamily,
  statusReading,
} from "../vocabulary";
import { WORK_STEP_LABELS, type WorkStep } from "@forge/contracts/issue-vocabulary";

export interface ToneBadgeProps {
  tone: LegendTone;
  label: ReactNode;
  glyph?: string | null;
  /** The tooltip: the raw value first, then what it means. */
  title: string;
  value?: string;
  size?: "sm" | "md";
  pulse?: boolean;
}

/** A legend-toned pill: glyph (or dot) and label. StatusBadge is this over a family's reading. */
export function ToneBadge({ tone, label, glyph, title, value, size = "sm", pulse }: ToneBadgeProps) {
  const c = LEGEND[tone];
  return (
    <span
      className={cn(
        "inline-flex max-w-full cursor-default items-center gap-1.5 whitespace-nowrap rounded-pill font-semibold",
        size === "sm" ? "py-[2px] text-11-5" : "py-[3px] text-12-5",
        // neutral is not moving: its words and dot, no ground, so a toned pill stands out beside it
        tone === "neutral" ? "pl-0.5 pr-1" : size === "sm" ? "px-2" : "px-2.5",
      )}
      style={{ color: c.fg, background: tone === "neutral" ? "transparent" : c.bg }}
      title={title}
      data-value={value}
      data-tone={tone}
      data-testid="status-badge"
    >
      {glyph ? (
        <span aria-hidden className={cn("text-[10px] leading-none", pulse && "forge-pulse")} style={{ color: c.dot }}>
          {glyph}
        </span>
      ) : (
        <span aria-hidden className={cn("size-1.5 flex-none rounded-full", pulse && "forge-pulse")} style={{ background: c.dot }} />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

export interface StatusBadgeProps {
  family: StatusFamily;
  value: string;
  /** An issue `in_progress` at a step reads "In progress · Test". */
  step?: WorkStep | null;
  /** A tone core derived for this project (an issue's `standing.tone`), over the family's default. */
  tone?: LegendTone;
  size?: "sm" | "md";
}

export function StatusBadge({ family, value, step, tone, size }: StatusBadgeProps) {
  const r = statusReading(family, value);
  const label = family === "issue" && value === "in_progress" && step ? `${r.label} · ${WORK_STEP_LABELS[step]}` : r.label;
  const shown = tone ?? r.tone;
  return (
    <ToneBadge
      tone={shown}
      label={label}
      glyph={r.glyph}
      value={value}
      size={size}
      pulse={shown === "run"}
      title={r.hint ? `${value} · ${r.hint.charAt(0).toUpperCase()}${r.hint.slice(1)}` : value}
    />
  );
}

function Bars({ n }: { n: number }) {
  return (
    <span aria-hidden className="inline-flex items-end gap-[1.5px]">
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-[1px]"
          style={{ height: 3 + i * 2, background: i <= n ? "var(--fg-muted)" : "var(--paper-300)" }}
        />
      ))}
    </span>
  );
}

/** A family with no field named reads as words in the tooltip: `failureCause` → "failure cause". */
const fieldWords = (family: string) => family.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const FIELD: Partial<Record<EnumFamily, string>> = {
  feedbackKind: "kind",
  feedbackRoute: "route",
  feedbackTarget: "target",
  feedbackDecision: "decision",
  changeKind: "kind",
  interfaceType: "type",
  jobType: "step",
  sessionKind: "kind",
  blockerKind: "blocker",
  dependencyKind: "kind",
  pauseKind: "kind",
  notificationType: "type",
  fireTrigger: "trigger",
  scheduleKind: "kind",
};

export interface EnumBadgeProps {
  family: EnumFamily;
  value: string;
  /** Overrides the label (e.g. "High priority" on a facts line). */
  label?: string;
}

/** A non-state enum: neutral ground, an icon (priority's bars), a sentence-case label. */
export function EnumBadge({ family, value, label }: EnumBadgeProps) {
  const text = label ?? enumLabel(family, value);
  return (
    <span
      className="inline-flex max-w-full cursor-default items-center gap-1.5 whitespace-nowrap rounded-[4px] bg-sunken px-1.5 py-[2px] text-11-5 font-medium text-muted"
      title={`${FIELD[family] ?? fieldWords(family)}: ${value}`}
      data-value={value}
      data-testid="enum-badge"
    >
      {family === "priority" ? <Bars n={PRIORITY_BARS[value] ?? 0} /> : <span aria-hidden className="text-[10px] leading-none text-subtle">◇</span>}
      <span className="truncate">{text}</span>
    </span>
  );
}
