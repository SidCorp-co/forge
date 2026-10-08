"use client";

// What a requirement's standing (core `requirements/standing.ts`) says, put into the shared design
// pieces: its whose-turn as the shared banner, its lifecycle as the shared step bar, its coverage as
// one mark or dot per criterion in the verdict's own tone. Nothing here draws a colour of its own.

import {
  BC_VERDICT_TONES,
  type BcVerdict,
  criteriaCoverageOf,
  REQUIREMENT_LIFECYCLE,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingKind,
} from "@forge/contracts/requirements";
import { type BannerTone, LEGEND, MarkStrip, StepBar, WaitBanner } from "@/design";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { cn } from "@/lib/utils/cn";

/** Stale is hatched rather than a tone, so it never reads as a verdict of its own colour. */
const VERDICT_FILL: Partial<Record<BcVerdict, string>> = {
  stale: "repeating-linear-gradient(135deg, var(--ink-400) 0 3px, var(--paper-400) 3px 6px)",
  not_judged: "var(--paper-400)",
};

/** A verdict's colour: its tone's dot, or the fill it draws in place of one. */
export const verdictFill = (v: BcVerdict) => VERDICT_FILL[v] ?? LEGEND[BC_VERDICT_TONES[v]].dot;

/** One criterion's verdict as a dot, named by the verdict's own word for a screen reader and on hover. */
export function VerdictDot({ verdict }: { verdict: BcVerdict }) {
  const label = useLabel();
  return (
    <span
      role="img"
      aria-label={label("bcVerdict", verdict)}
      title={`${label("bcVerdict", verdict)}: ${label("hintBcVerdict", verdict)}`}
      className="mt-1.5 block size-2.5 flex-none rounded-full"
      style={{ background: verdictFill(verdict) }}
      data-testid="verdict-dot"
      data-verdict={verdict}
    />
  );
}

const onLifecycle = (state: RequirementState) => REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);

/** Draft → Agreed → In delivery → Delivered → Accepted; a delivered one waits on a person's acceptance. */
function Stepper({ state }: { state: RequirementState }) {
  const t = useCopy();
  const label = useLabel();
  const at = onLifecycle(state);
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

/** The strip's first line: whom it waits on and for what, or that nothing is owed. */
function RequirementBanner({ standing, className }: { standing: RequirementStanding; className?: string }) {
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
      effect={done ? undefined : w.effect}
      className={className}
    />
  );
}

/**
 * The top of a requirement on every width, its full page's and its peek's alike: whom it waits on and
 * for what, the lifecycle step it stands at and the one after, and "k/n verified" with a mark per
 * criterion. Every word is the lifecycle's and the verdicts' own; this draws no step or verdict of its own.
 */
export function RequirementProgress({ standing, inset }: { standing: RequirementStanding; inset: string }) {
  const t = useCopy();
  const label = useLabel();
  const { passing: k, criteria: n } = criteriaCoverageOf(standing.coverage);
  const line = onLifecycle(standing.state) >= 0;
  return (
    <section aria-label={t("requirements.progress.label")} className="border-b border-line-subtle bg-surface" data-testid="requirement-progress">
      <RequirementBanner standing={standing} className={cn(inset, "py-2.5")} />
      {line || n > 0 ? (
        <div className={cn("flex flex-wrap items-start gap-x-8 gap-y-3 py-3", inset)}>
          {line ? (
            <div className="min-w-[min(100%,300px)] max-w-[560px] flex-1">
              <Stepper state={standing.state} />
            </div>
          ) : null}
          {n > 0 ? (
            <div className="grid gap-1.5" data-testid="progress-verified">
              <span className="text-13 font-semibold text-fg">{t("requirements.verified", { a: k, b: n })}</span>
              <MarkStrip size="sm" marks={standing.coverage.map((c) => ({ key: c.code, label: `${c.code} · ${label("bcVerdict", c.verdict)}`, fill: verdictFill(c.verdict) }))} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
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
