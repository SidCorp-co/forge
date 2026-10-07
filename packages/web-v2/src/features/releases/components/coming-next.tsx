"use client";

// What comes next, on top of Releases: each requirement with work still to land and when it is in
// people's hands (core's `forecast/scope.ts:readComingNext`), then the draft and the act it waits on
// (core's release read model). Flush rows on hairlines; the reasons sit in the tooltips.

import type { ComingNextForecast, ScopeForecast } from "@forge/contracts/forecast";
import Link from "next/link";
import { ViewHeading } from "@/design";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import { IssueProgressText } from "@/features/forecast/components/issue-progress";
import { type Eta, type EtaClock, etaOfScope } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { standingAct, standingWho } from "@/lib/i18n/standing-copy";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseSummary } from "../types";

const GRID = "grid grid-cols-[104px_minmax(0,1fr)_minmax(0,300px)_128px] items-center gap-x-3.5 px-5 max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:px-3";
const ROW = `${GRID} min-h-[44px] border-b border-line-subtle py-1.5`;

/** "Waiting on you: cut 0.1.0" — the draft's own turn, as the release read model gives it to this viewer. */
function draftTurnText(draft: ReleaseSummary, t: Copy, language: string): string | null {
  const w = draft.waitingOn;
  if (w.kind === "none" || !w.act) return null;
  const act = standingAct(w.act, language);
  return w.kind === "you" ? t("releases.waitingOnYouAct", { act }) : t("releases.waitingOnAct", { who: standingWho(w.who, language), act });
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
        <ViewHeading hint={t("releases.comingNextHint")}>{t("releases.comingNext")}</ViewHeading>
      </div>
      <div className={`${GRID} h-8 border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle max-md:hidden`} data-testid="coming-next-header">
        <span>{t("list.col.key")}</span>
        <span>{t("list.col.title")}</span>
        <span className="text-right">{t("releases.colProgress")}</span>
        <span className="text-right">{ETA_COPY[clock.lang].header}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {requirements.map((s) => (
          <li key={s.key} className={ROW} data-testid="coming-next-requirement" data-key={s.key}>
            <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={requirementHref(slug, s.key)}>
              {s.key}
            </Link>
            <span className="min-w-0 truncate text-13 text-fg max-md:order-3 max-md:col-span-3">{s.title}</span>
            <IssueProgressText progress={s.progress} className="truncate text-right text-12 text-muted tabular-nums" />
            <EtaCell eta={etaOfScope(s, clock)} clock={clock} />
          </li>
        ))}
        {draft ? (
          <li className={ROW} data-testid="coming-next-draft" data-key={draft.key}>
            <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={releaseHref(slug, draft.version)}>
              {draft.version}
            </Link>
            <span className="flex min-w-0 flex-col max-md:order-3 max-md:col-span-3">
              <span className="truncate text-13 text-fg">{t("releases.draftRelease", { n: draft.issueCount })}</span>
              {turn ? (
                <span className="truncate text-12-5 font-semibold text-fg" title={draft.waitingOn.rule} data-testid="coming-next-draft-turn">
                  {turn}
                </span>
              ) : null}
            </span>
            {draftScope && draftScope.progress.total > 0 ? (
              <IssueProgressText progress={draftScope.progress} className="truncate text-right text-12 text-muted tabular-nums" />
            ) : (
              <span />
            )}
            <EtaCell eta={draftEta(draftScope, clock)} clock={clock} />
          </li>
        ) : null}
      </ul>
    </section>
  );
}
