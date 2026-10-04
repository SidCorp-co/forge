"use client";

// What a requirement's standing (core `requirements/standing.ts`) says, put into the shared design
// pieces: its whose-turn as the shared WaitingOn and banner, its coverage as the shared bar and marks,
// its lifecycle as the shared step bar. Nothing here draws a colour of its own.

import {
  BC_VERDICT_HINTS,
  BC_VERDICT_LABELS,
  BC_VERDICT_TONES,
  type BcVerdict,
  REQUIREMENT_LIFECYCLE,
  REQUIREMENT_STATE_LABELS,
  type RequirementCoverage,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingKind,
} from "@forge/contracts/requirements";
import type { ReactNode } from "react";
import {
  type BannerTone,
  type CoverageSegment,
  CoverageBar,
  LEGEND,
  type MarkView,
  StepBar,
  WaitBanner,
} from "@/design";

/** Stale is hatched rather than a tone, so it never reads as a verdict of its own colour. */
const VERDICT_FILL: Partial<Record<BcVerdict, string>> = {
  stale: "repeating-linear-gradient(135deg, var(--ink-400) 0 3px, var(--paper-400) 3px 6px)",
  not_judged: "var(--paper-400)",
};

const VERDICT_ORDER: BcVerdict[] = ["passing", "failing", "stale", "not_judged", "gap"];

export const coverageMarks = (coverage: RequirementCoverage[]): MarkView[] =>
  coverage.map((c) => ({
    key: c.code,
    label: `${c.code} · ${BC_VERDICT_LABELS[c.verdict]} — ${c.body}`,
    tone: BC_VERDICT_TONES[c.verdict],
    fill: VERDICT_FILL[c.verdict],
  }));

/** Passing n of m as the shared stacked bar, a legend naming each verdict present. */
export function CoverageSummary({ coverage }: { coverage: RequirementCoverage[] }) {
  if (coverage.length === 0) return <p className="text-12-5 text-subtle">No criteria yet.</p>;
  const segments: CoverageSegment[] = VERDICT_ORDER.map((v) => ({
    key: v,
    label: BC_VERDICT_LABELS[v],
    count: coverage.filter((c) => c.verdict === v).length,
    tone: BC_VERDICT_TONES[v],
    fill: VERDICT_FILL[v],
    hint: BC_VERDICT_HINTS[v].replace(/^[a-z_]+: /, ""),
  }));
  return <CoverageBar segments={segments} />;
}

/** Draft → Agreed → In delivery → Delivered → Accepted; a delivered one waits on a person's acceptance. */
export function Stepper({ state }: { state: RequirementState }) {
  const at = REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);
  if (at < 0) return null;
  const next = REQUIREMENT_LIFECYCLE[at + 1];
  return (
    <StepBar
      steps={REQUIREMENT_LIFECYCLE.map((s, i) => ({
        key: s,
        label: REQUIREMENT_STATE_LABELS[s],
        state: i < at || (i === at && s === "accepted") ? "done" : i === at ? "now" : "next",
        tone: s === "delivered" ? "you" : "run",
      }))}
      caption={`Step ${at + 1} of ${REQUIREMENT_LIFECYCLE.length}${next ? ` · next ${REQUIREMENT_STATE_LABELS[next]}` : ""}`}
    />
  );
}

const BANNER_TONE: Record<RequirementWaitingKind, BannerTone> = {
  you: "you",
  person: "calm",
  agent: "agent",
  issue: "run",
  none: "calm",
};

/** The full page's and the peek's one-line banner: whom it waits on and for what. */
export function RequirementBanner({ standing, children, className }: { standing: RequirementStanding; children?: ReactNode; className?: string }) {
  const w = standing.waitingOn;
  const stuck = standing.attentionGroup === "stuck" && w.kind === "none";
  const done = standing.attentionGroup === "done";
  return (
    <WaitBanner
      tone={stuck ? "you" : BANNER_TONE[w.kind]}
      head={done ? (standing.state === "accepted" ? "Accepted." : "Dropped.") : stuck ? "Stuck:" : `Waiting on ${w.kind === "you" ? "you" : w.who}:`}
      body={done ? "Nothing is owed on it." : stuck ? "no owner; someone has to take it." : w.act}
      rule={w.rule}
      className={className}
    >
      {children}
    </WaitBanner>
  );
}

/** "Rev 4 · r5 awaiting sign-off": the revision fact a list row carries, in words rather than raw state names. */
export function revisionText(current: number | null, s: RequirementStanding): string {
  const open = s.facts.proposedRevision ?? s.facts.draftRevision;
  const head = current !== null ? `Rev ${current}` : "No accepted revision";
  if (open === null) return head;
  return `${head} · r${open} ${s.facts.proposedRevision !== null ? "awaiting sign-off" : "being drafted"}`;
}

/** The diff's inserted and deleted text, in the legend's ready and came-back colours. */
export const diffColours = { ins: LEGEND.ready, del: LEGEND.err };
