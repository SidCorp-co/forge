"use client";

// What a requirement's standing (core `requirements/standing.ts`) says, put into the shared design
// pieces: its whose-turn as the shared banner, the issue or release the wait is about linked inside its
// act, its lifecycle as the shared step bar, its coverage as a dot per verdict carrying the verdict's
// own glyph beside its own word, so a verdict is never told by colour alone. Nothing here draws a
// colour, a step or a verdict word of its own.

import Link from "next/link";
import {
  BC_VERDICTS,
  type BcVerdict,
  criteriaCoverageOf,
  REQUIREMENT_LIFECYCLE,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingKind,
  type RequirementWaitingOn,
} from "@forge/contracts/requirements";
import { type BannerTone, LEGEND, StepBar, statusReading, WaitBanner } from "@/design";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { cn } from "@/lib/utils/cn";

/** One verdict as a dot carrying the verdict's glyph (✓ × ↻ ○ !), so its shape tells it apart where its colour does not. */
export function VerdictDot({ verdict }: { verdict: BcVerdict }) {
  const r = statusReading("bcVerdict", verdict, useInterfaceLanguage());
  const c = LEGEND[r.tone];
  return (
    <span
      aria-hidden
      className="grid size-4 flex-none place-items-center rounded-full border text-[10px] font-bold leading-none"
      style={{ background: c.bg, borderColor: c.dot, color: c.fg }}
      data-testid="verdict-dot"
      data-verdict={verdict}
    >
      {r.glyph}
    </span>
  );
}

/** A verdict's own word, as text a sighted reader sees on every width; its hint on hover. */
export function VerdictWord({ verdict }: { verdict: BcVerdict }) {
  const r = statusReading("bcVerdict", verdict, useInterfaceLanguage());
  return (
    <span className="text-12 font-semibold" style={{ color: LEGEND[r.tone].fg }} title={r.hint ?? undefined} data-testid="verdict-word">
      {r.label}
    </span>
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
  release: "run",
  none: "calm",
};

/** Where what a wait is about lives: the parked issue's page, or the release's. */
const REFERS_HREF = {
  issue: issueHref,
  release: releaseHref,
} as const satisfies Record<NonNullable<RequirementWaitingOn["refers"]>, (slug: string, ref: string) => string>;

/** The act, with the issue or release it names linked where the wait says what it is about ("cut 0.1.0, then approve it"). */
function WaitAct({ act, w, slug }: { act: string; w: RequirementWaitingOn; slug: string }) {
  const at = w.refers && w.ref ? act.indexOf(w.ref) : -1;
  if (!w.refers || !w.ref || at < 0) return <>{act}</>;
  return (
    <>
      {act.slice(0, at)}
      <Link href={REFERS_HREF[w.refers](slug, w.ref)} className="whitespace-nowrap font-mono text-link hover:underline" data-testid="wait-ref" data-refers={w.refers}>
        {w.ref}
      </Link>
      {act.slice(at + w.ref.length)}
    </>
  );
}

/** The strip's first line: whom it waits on and for what, or that nothing is owed. */
function RequirementBanner({ standing, slug, className }: { standing: RequirementStanding; slug: string; className?: string }) {
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
      body={done ? t("requirements.banner.nothingOwed") : stuck ? t("requirements.banner.noOwner") : <WaitAct act={w.act} w={standing.waitingOn} slug={slug} />}
      rule={w.rule}
      effect={done ? undefined : w.effect}
      className={className}
    />
  );
}

/** How many criteria stand at each verdict, in the vocabulary's order; a verdict no criterion has is left out. */
const verdictCounts = (coverage: RequirementStanding["coverage"]) =>
  BC_VERDICTS.map((v) => ({ verdict: v, n: coverage.filter((c) => c.verdict === v).length })).filter((x) => x.n > 0);

/**
 * The top of a requirement on every width, its full page's and its peek's alike: whom it waits on and
 * for what, the lifecycle step it stands at and the one after, and "k/n verified" over a count per
 * verdict, each a glyph dot, a number and the verdict's word. Every word is the lifecycle's and the
 * verdicts' own; this draws no step or verdict of its own.
 */
export function RequirementProgress({ standing, slug, inset }: { standing: RequirementStanding; slug: string; inset: string }) {
  const t = useCopy();
  const { passing: k, criteria: n } = criteriaCoverageOf(standing.coverage);
  const line = onLifecycle(standing.state) >= 0;
  return (
    <section aria-label={t("requirements.progress.label")} className="border-b border-line-subtle bg-surface" data-testid="requirement-progress">
      <RequirementBanner standing={standing} slug={slug} className={cn(inset, "py-2.5")} />
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
              <ul className="flex flex-wrap gap-x-3 gap-y-1" data-testid="progress-verdicts">
                {verdictCounts(standing.coverage).map(({ verdict, n: count }) => (
                  <li key={verdict} className="inline-flex items-center gap-1.5 text-12" data-verdict={verdict}>
                    <VerdictDot verdict={verdict} />
                    <b className="font-semibold text-fg">{count}</b>
                    <VerdictWord verdict={verdict} />
                  </li>
                ))}
              </ul>
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
