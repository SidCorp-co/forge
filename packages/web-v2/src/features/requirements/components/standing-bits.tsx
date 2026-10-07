"use client";

// What a requirement's standing (core `requirements/standing.ts`) says, put into the shared design
// pieces: its whose-turn as the shared WaitingOn and banner, its coverage as the shared bar and marks,
// its lifecycle as the shared step bar. Nothing here draws a colour of its own.

import {
  BC_VERDICT_TONES,
  type BcVerdict,
  REQUIREMENT_LIFECYCLE,
  type RequirementCoverage,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingKind,
} from "@forge/contracts/requirements";
import type { ReactNode } from "react";
import { type BannerTone, type CoverageSegment, CoverageBar, LEGEND, StepBar, WaitBanner } from "@/design";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";

/** Stale is hatched rather than a tone, so it never reads as a verdict of its own colour. */
const VERDICT_FILL: Partial<Record<BcVerdict, string>> = {
  stale: "repeating-linear-gradient(135deg, var(--ink-400) 0 3px, var(--paper-400) 3px 6px)",
  not_judged: "var(--paper-400)",
};

const VERDICT_ORDER: BcVerdict[] = ["passing", "failing", "stale", "not_judged", "gap"];

/** Passing n of m as the shared stacked bar, a legend naming each verdict present. */
export function CoverageSummary({ coverage }: { coverage: RequirementCoverage[] }) {
  const t = useCopy();
  const label = useLabel();
  if (coverage.length === 0) return <p className="text-12-5 text-subtle">{t("requirements.coverage.none")}</p>;
  const segments: CoverageSegment[] = VERDICT_ORDER.map((v) => ({
    key: v,
    label: label("bcVerdict", v),
    count: coverage.filter((c) => c.verdict === v).length,
    tone: BC_VERDICT_TONES[v],
    fill: VERDICT_FILL[v],
    hint: label("hintBcVerdict", v),
  }));
  return <CoverageBar segments={segments} />;
}

/** Draft → Agreed → In delivery → Delivered → Accepted; a delivered one waits on a person's acceptance. */
export function Stepper({ state }: { state: RequirementState }) {
  const t = useCopy();
  const label = useLabel();
  const at = REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);
  if (at < 0) return null;
  const next = REQUIREMENT_LIFECYCLE[at + 1];
  return (
    <StepBar
      steps={REQUIREMENT_LIFECYCLE.map((s, i) => ({
        key: s,
        label: label("requirementState", s),
        state: i < at || (i === at && s === "accepted") ? "done" : i === at ? "now" : "next",
        tone: s === "delivered" ? "you" : "run",
      }))}
      caption={stepCaption(t, at + 1, REQUIREMENT_LIFECYCLE.length, next ? label("requirementState", next) : null)}
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
  const t = useCopy();
  const w = saidView(standing.waitingOn, useInterfaceLanguage());
  const stuck = standing.attentionGroup === "stuck" && w.kind === "none";
  const done = standing.attentionGroup === "done";
  return (
    <WaitBanner
      tone={stuck ? "you" : BANNER_TONE[w.kind]}
      head={t(
        done ? (standing.state === "accepted" ? "requirements.banner.accepted" : "requirements.banner.dropped") : stuck ? "requirements.banner.stuck" : w.kind === "you" ? "requirements.banner.waitingOnYou" : "requirements.banner.waitingOn",
        { who: w.who },
      )}
      body={done ? t("requirements.banner.nothingOwed") : stuck ? t("requirements.banner.noOwner") : w.act}
      rule={w.rule}
      effect={w.effect}
      className={className}
    >
      {children}
    </WaitBanner>
  );
}

/** "Rev 4 · r5 awaiting sign-off": the revision fact a list row carries, in words rather than raw state names. */
export function revisionText(t: Copy, current: number | null, s: RequirementStanding): string {
  const open = s.facts.proposedRevision ?? s.facts.draftRevision;
  const head = current !== null ? t("requirements.row.rev", { n: current }) : t("requirements.row.noAcceptedRevision");
  if (open === null) return head;
  return t(s.facts.proposedRevision !== null ? "requirements.row.revAwaiting" : "requirements.row.revDrafting", { head, r: open });
}

/** "Step 2 of 5 · next In delivery". */
const stepCaption = (t: Copy, at: number, of: number, next: string | null) => {
  const caption = t("requirements.step.caption", { at, of });
  return next ? t("requirements.step.next", { caption, state: next }) : caption;
};

/** "Agreed 03/10/2026, 14:05 by Lan": when a revision was agreed and by whom, for a tooltip. */
export const agreedTitle = (t: Copy, at: string, name: string | null) =>
  name ? t("requirements.revision.agreedAtBy", { at, name }) : t("requirements.revision.agreedAt", { at });

/** The diff's inserted and deleted text, in the legend's ready and came-back colours. */
export const diffColours = { ins: LEGEND.ready, del: LEGEND.err };
