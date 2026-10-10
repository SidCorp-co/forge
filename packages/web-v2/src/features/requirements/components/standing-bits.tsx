"use client";

// What a requirement's standing (core `requirements/standing.ts`) says, put into the shared design
// pieces: its whose-turn as the shared banner, the issue or release the wait is about linked inside its
// act, its lifecycle as the shared step bar, and each verdict as a dot carrying the verdict's own
// glyph and named on it, so a verdict is never told by colour alone. Nothing here draws a colour, a
// step or a verdict word of its own. The header's badge says the state, so neither the banner nor the
// bar says it again (REQ-43 BC-5).

import Link from "next/link";
import {
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

/**
 * One verdict as a dot carrying the verdict's glyph (✓ × ↻ ⇣ ○ !), so its shape tells it apart where
 * its colour does not; named on it, since it is the verdict's one mark on its row (REQ-43 BC-10).
 */
export function VerdictDot({ verdict }: { verdict: BcVerdict }) {
  const r = statusReading("bcVerdict", verdict, useInterfaceLanguage());
  const c = LEGEND[r.tone];
  return (
    <span
      role="img"
      aria-label={r.label}
      title={r.label}
      className="grid size-4 flex-none place-items-center rounded-pill border text-12 font-bold leading-none"
      style={{ background: c.bg, borderColor: c.dot, color: c.fg }}
      data-testid="verdict-dot"
      data-verdict={verdict}
    >
      {r.glyph}
    </span>
  );
}

const onLifecycle = (state: RequirementState) => REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);

/**
 * Draft → Agreed → In delivery → Delivered → Accepted as a bar, and the step core says comes next. The
 * header's badge names the state, so the bar draws its place and names no step of its own.
 */
function Stepper({ state, next }: { state: RequirementState; next: RequirementState | null }) {
  const t = useCopy();
  const label = useLabel();
  const at = onLifecycle(state);
  // deferred is off the line: it says the step it goes back to
  if (at < 0) {
    return next ? (
      <p className="text-12 text-muted" data-testid="step-off-line">
        {t("requirements.step.next", { state: label("requirementState", next) })}
      </p>
    ) : null;
  }
  return (
    <StepBar
      steps={REQUIREMENT_LIFECYCLE.map((s, i) => ({
        key: s,
        label: label("requirementState", s),
        state: i < at || (i === at && s === "accepted") ? "done" : i === at ? "now" : "next",
        tone: s === "delivered" ? "you" : "run",
      }))}
      caption={next ? t("requirements.step.next", { state: label("requirementState", next) }) : undefined}
      named={false}
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

/** The strip's first line: whom it waits on and for what, or that nothing is owed (the badge says it ended). */
function RequirementBanner({ standing, slug, className }: { standing: RequirementStanding; slug: string; className?: string }) {
  const t = useCopy();
  const w = saidView(standing.waitingOn, useInterfaceLanguage());
  const stuck = standing.attentionGroup === "stuck" && w.kind === "none";
  const done = standing.attentionGroup === "done";
  return (
    <WaitBanner
      tone={stuck ? "you" : BANNER_TONE[w.kind]}
      head={t(done ? "requirements.banner.nothingOwed" : stuck ? "requirements.banner.stuck" : w.kind === "you" ? "requirements.banner.waitingOnYou" : "requirements.banner.waitingOn", { who: w.who })}
      body={done ? null : stuck ? t("requirements.banner.noOwner") : <WaitAct act={w.act} w={standing.waitingOn} slug={slug} />}
      rule={w.rule}
      effect={done ? undefined : w.effect}
      className={className}
    />
  );
}

/**
 * The top of a requirement on every width, its full page's and its peek's alike: whom it waits on and
 * for what, where it stands on the lifecycle and the step after, and "k/n verified". The count per
 * verdict lives in the criteria's filter (REQ-43 BC-10), so the strip counts no verdict.
 */
export function RequirementProgress({ standing, slug, inset }: { standing: RequirementStanding; slug: string; inset: string }) {
  const t = useCopy();
  const { passing: k, criteria: n } = criteriaCoverageOf(standing.coverage);
  const line = onLifecycle(standing.state) >= 0 || standing.next !== null;
  return (
    <section aria-label={t("requirements.progress.label")} className="border-b border-line-subtle bg-surface" data-testid="requirement-progress">
      <RequirementBanner standing={standing} slug={slug} className={cn(inset, "py-2.5")} />
      {line || n > 0 ? (
        <div className={cn("flex flex-wrap items-start gap-x-8 gap-y-3 py-3", inset)}>
          {line ? (
            <div className="min-w-0 max-w-140 grow basis-75">
              <Stepper state={standing.state} next={standing.next} />
            </div>
          ) : null}
          {n > 0 ? (
            <div data-testid="progress-verified">
              <span className="text-13 font-semibold text-fg">{t("requirements.verified", { a: k, b: n })}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** "Agreed 03/10/2026, 14:05 by Lan": when a revision was agreed and by whom, for a tooltip. */
export const agreedTitle = (t: Copy, at: string, name: string | null) =>
  name ? t("requirements.revision.agreedAtBy", { at, name }) : t("requirements.revision.agreedAt", { at });

/** The diff's inserted and deleted text, in the legend's ready and came-back colours. */
export const diffColours = { ins: LEGEND.ready, del: LEGEND.err };
