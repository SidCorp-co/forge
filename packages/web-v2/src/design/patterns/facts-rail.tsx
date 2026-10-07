"use client";

// The at-a-glance facts of one item: a sticky rail beside the full page's main column, and the body
// of its peek. Groups are headed in the primary colour one step above their labels, with a
// label-first counter on the right ("Passing 2 of 4"); each row is a label and its value. Each fact
// appears here once and the main column never repeats it.

import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { Tooltip } from "../primitives/tooltip";
import { LEGEND, type LegendTone } from "../vocabulary";

/** The rail itself: a raised white working surface beside the page-toned main column, one hairline
 *  between them; sticky under the top bar,
 *  scrolling on its own when it is taller than the screen; below 1024px it follows the content. */
export function FactsRail({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
  const t = useCopy();
  return (
    <aside className="min-w-0 border-line-subtle bg-surface max-lg:border-t lg:border-l" aria-label={label ?? t("common.facts")} data-testid={testId ?? "facts-rail"}>
      <div className="px-5 py-5 max-md:px-4 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-48px)] lg:overflow-y-auto" data-testid="facts-rail-body">
        {children}
      </div>
    </aside>
  );
}

export function FactsGroup({ title, count, children, testId }: { title: string; count?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0" data-testid={testId ?? "facts-group"}>
      <h3 className="mb-2 flex items-baseline gap-2 text-14 font-bold text-accent-text">
        {title}
        {count ? <span className="ml-auto text-12 font-medium text-muted">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-2 py-[5px] text-13" data-testid={testId}>
      <span className="text-12-5 font-medium text-muted">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</span>
    </div>
  );
}

/** A quiet line for a group with nothing in it: "Not broken down into issues yet." */
export function FactsEmpty({ children }: { children: ReactNode }) {
  return <p className="text-12-5 text-subtle">{children}</p>;
}

export interface CoverageSegment {
  key: string;
  label: string;
  count: number;
  tone?: LegendTone;
  /** A fill other than a tone's dot, e.g. the hatched "stale". */
  fill?: string;
  hint?: string;
}

const fillOf = (s: CoverageSegment) => s.fill ?? (s.tone ? LEGEND[s.tone].dot : "var(--paper-400)");

/** A stacked bar over a whole, and a legend naming each segment present with its count. */
export function CoverageBar({ segments, legend = true }: { segments: readonly CoverageSegment[]; legend?: boolean }) {
  const total = segments.reduce((n, s) => n + s.count, 0);
  const present = segments.filter((s) => s.count > 0);
  if (total === 0) return null;
  return (
    <div data-testid="coverage-bar">
      <div className="flex h-2 overflow-hidden rounded-pill bg-[var(--paper-200)]" role="img" aria-label={present.map((s) => `${s.label} ${s.count}`).join(", ")}>
        {present.map((s) => (
          <span key={s.key} className="h-full" style={{ width: `${(s.count / total) * 100}%`, background: fillOf(s) }} />
        ))}
      </div>
      {legend ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-12">
          {present.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5 text-muted" title={s.hint}>
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: fillOf(s) }} />
              {s.label} <b className="font-semibold text-fg">{s.count}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface MarkView {
  key: string;
  label: string;
  tone?: LegendTone;
  fill?: string;
}

/** One small mark per item (a criterion, a step), coloured by its state; the item on hover. */
export function MarkStrip({ marks, size = "md", className }: { marks: readonly MarkView[]; size?: "sm" | "md"; className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-0.5", className)} role="img" aria-label={marks.map((m) => m.label).join(", ")}>
      {marks.map((m) => (
        <Tooltip key={m.key} label={m.label} multiline>
          <span
            className="block rounded-[2px]"
            style={{ width: size === "sm" ? 14 : 18, height: size === "sm" ? 8 : 10, background: m.fill ?? (m.tone ? LEGEND[m.tone].dot : "var(--paper-300)") }}
          />
        </Tooltip>
      ))}
    </span>
  );
}

export interface StepView {
  key: string;
  label: string;
  state: "done" | "now" | "next";
  /** Shown under the label, e.g. "1h 26m". */
  meta?: string;
  tone?: LegendTone;
}

/** A lifecycle as one segmented bar with its step names under it; the current step is toned. */
export function StepBar({ steps, caption }: { steps: readonly StepView[]; caption?: ReactNode }) {
  const t = useCopy();
  return (
    <div data-testid="step-bar">
      <ol className="flex gap-[3px]" aria-label={t("common.lifecycle")}>
        {steps.map((s) => (
          <li key={s.key} className="min-w-0 flex-1" aria-current={s.state === "now" ? "step" : undefined} title={t(s.state === "done" ? "common.stepDone" : s.state === "now" ? "common.stepNow" : "common.stepNext", { label: s.label })}>
            <span
              aria-hidden
              className="block h-1.5 rounded-pill"
              style={{ background: s.state === "now" ? LEGEND[s.tone ?? "run"].dot : s.state === "done" ? "var(--ink-600)" : "var(--paper-300)" }}
            />
            <span className={cn("mt-1 block truncate text-11-5", s.state === "now" ? "font-semibold text-fg" : "text-subtle")}>{s.label}</span>
            {s.meta ? <span className="block truncate font-mono text-11 text-subtle">{s.meta}</span> : null}
          </li>
        ))}
      </ol>
      {caption ? <div className="mt-1 text-12 text-subtle">{caption}</div> : null}
    </div>
  );
}
