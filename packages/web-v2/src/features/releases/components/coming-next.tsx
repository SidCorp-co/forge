"use client";

// What comes next, on top of Releases: each requirement with work still to land and when it is in
// people's hands (core's `forecast/scope.ts:readComingNext`), then the draft and the act it waits on
// (core's release read model). Flush rows on hairlines; the reasons sit in the tooltips.

import type { ComingNextForecast, ScopeForecast } from "@forge/contracts/forecast";
import Link from "next/link";
import { ViewHeading } from "@/design";
import { EtaCell } from "@/features/forecast";
import { IssueProgressText } from "@/features/forecast";
import { type Eta, type EtaClock, etaOfScope } from "@/features/forecast";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseSummary } from "../types";

const LINE = "flex items-center gap-x-3.5 px-5 max-md:flex-wrap max-md:px-3";
const ROW = `${LINE} min-h-11 border-b border-line-subtle py-1.5`;
/** The four columns; on a phone the title drops to its own line under the key, progress and landing. */
const COL = {
  key: "w-26 flex-none font-mono text-13 font-semibold text-link hover:underline max-md:w-auto",
  title: "min-w-0 flex-1 max-md:order-last max-md:basis-full",
  progress: "w-75 min-w-0 shrink truncate text-right text-12 text-muted tabular-nums max-md:ml-auto max-md:w-auto",
  eta: "w-32 flex-none",
};

/** "Waiting on you: cut 0.1.0" — the draft's own turn, as the release read model gives it to this viewer. */
function draftTurnText(draft: ReleaseSummary, t: Copy, language: string): string | null {
  const w = draft.waitingOn;
  const act = said(w.says.act, language);
  if (w.kind === "none" || !act) return null;
  return w.kind === "you" ? t("releases.waitingOnYouAct", { act }) : t("releases.waitingOnAct", { who: said(w.says.who, language), act });
}

/** The draft's cell: its landing, never ticked while it waits for the release; the act it waits on is its turn line, said once. */
function draftEta(scope: ScopeForecast | undefined, clock: EtaClock): Eta | null {
  const eta = etaOfScope(scope, clock);
  return eta && (eta.kind === "landed" || eta.kind === "range" || eta.kind === "done") ? { ...eta, tail: null } : eta;
}

export function ComingNext({
  next,
  draft,
  slug,
  clock,
}: {
  next: ComingNextForecast | undefined;
  draft: ReleaseSummary | undefined;
  slug: string;
  clock: EtaClock;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const requirements = next?.requirements ?? [];
  if (requirements.length === 0 && !draft) return null;
  const turn = draft ? draftTurnText(draft, t, language) : null;
  const draftScope = next?.draft;
  return (
    <section aria-label={t("releases.comingNext")} className="pt-4" data-testid="coming-next">
      <div className="px-5 max-md:px-3">
        <ViewHeading>{t("releases.comingNext")}</ViewHeading>
      </div>
      <div className={`${LINE} h-8 border-y border-line-subtle bg-sunken text-12 font-semibold text-subtle max-md:hidden`} data-testid="coming-next-header">
        <span className="w-26 flex-none">{t("list.col.key")}</span>
        <span className="min-w-0 flex-1">{t("list.col.title")}</span>
        <span className="w-75 min-w-0 shrink text-right">{t("releases.colProgress")}</span>
        <span className="w-32 flex-none text-right">{ETA_COPY[clock.lang].header}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {requirements.map((s) => (
          <li key={s.key} className={ROW} data-testid="coming-next-requirement" data-key={s.key}>
            <Link className={COL.key} href={requirementHref(slug, s.key)}>
              {s.key}
            </Link>
            <span className={`${COL.title} truncate text-13 text-fg`}>{s.title}</span>
            <IssueProgressText progress={s.progress} className={COL.progress} />
            <span className={COL.eta}>
              <EtaCell eta={etaOfScope(s, clock)} clock={clock} />
            </span>
          </li>
        ))}
        {draft ? (
          <li className={ROW} data-testid="coming-next-draft" data-key={draft.key}>
            <Link className={COL.key} href={releaseHref(slug, draft.version)}>
              {draft.version}
            </Link>
            <span className={`${COL.title} flex flex-col`}>
              <span className="truncate text-13 text-fg">{t("releases.draftRelease", { n: draft.issueCount })}</span>
              {turn ? (
                <span className="truncate text-13 font-semibold text-fg" title={said(draft.waitingOn.says.rule, language)} data-testid="coming-next-draft-turn">
                  {turn}
                </span>
              ) : null}
            </span>
            {draftScope && draftScope.progress.total > 0 ? (
              <IssueProgressText progress={draftScope.progress} className={COL.progress} />
            ) : (
              <span className={COL.progress} />
            )}
            <span className={COL.eta}>
              <EtaCell eta={draftEta(draftScope, clock)} clock={clock} />
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
