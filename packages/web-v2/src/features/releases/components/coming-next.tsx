"use client";

// What comes next, on top of Releases: each requirement with work still to land and when it is in
// people's hands (core's `forecast/scope.ts:readComingNext`), then the draft and the act it waits on
// (core's release read model). Flush rows on hairlines; the reasons sit in the tooltips.

import type { ComingNextForecast } from "@forge/contracts/forecast";
import Link from "next/link";
import { ViewHeading } from "@/design";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import { type EtaClock, etaOfForecast, etaOfScope } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseSummary } from "../types";

const GRID = "grid grid-cols-[104px_minmax(0,1fr)_96px_128px] items-center gap-x-3.5 px-5 max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:px-3";
const ROW = `${GRID} min-h-[44px] border-b border-line-subtle py-1.5`;

/** "Waiting on you: cut 0.1.0" — the draft's own turn, as the release read model gives it to this viewer. */
export function draftTurnText(draft: ReleaseSummary): string | null {
  const w = draft.waitingOn;
  if (w.kind === "none" || !w.act) return null;
  return `Waiting on ${w.kind === "you" ? "you" : w.who}: ${w.act}`;
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
  const requirements = next?.requirements ?? [];
  if (requirements.length === 0 && !draft) return null;
  const turn = draft ? draftTurnText(draft) : null;
  const draftScope = next?.draft;
  return (
    <section aria-label="Coming next" className="pt-4" data-testid="coming-next">
      <div className="px-5 max-md:px-3">
        <ViewHeading hint="Open work per requirement, and when it is in people's hands">Coming next</ViewHeading>
      </div>
      <div className={`${GRID} h-8 border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle max-md:hidden`} data-testid="coming-next-header">
        <span>Key</span>
        <span>Title</span>
        <span className="text-right">Landed</span>
        <span className="text-right">{ETA_COPY[clock.lang].header}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {requirements.map((s) => (
          <li key={s.key} className={ROW} data-testid="coming-next-requirement" data-key={s.key}>
            <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={requirementHref(slug, s.key)}>
              {s.key}
            </Link>
            <span className="min-w-0 truncate text-13 text-fg max-md:order-3 max-md:col-span-3">{s.title}</span>
            <span className="text-right text-12 text-muted tabular-nums">
              {s.landed}/{s.total} landed
            </span>
            <EtaCell eta={etaOfScope(s, clock)} clock={clock} />
          </li>
        ))}
        {draft ? (
          <li className={ROW} data-testid="coming-next-draft" data-key={draft.key}>
            <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={releaseHref(slug, draft.version)}>
              {draft.version}
            </Link>
            <span className="flex min-w-0 flex-col max-md:order-3 max-md:col-span-3">
              <span className="truncate text-13 text-fg">Draft release · Issues {draft.issueCount}</span>
              {turn ? (
                <span className="truncate text-12-5 font-semibold text-fg" title={draft.waitingOn.rule} data-testid="coming-next-draft-turn">
                  {turn}
                </span>
              ) : null}
            </span>
            <span className="text-right text-12 text-muted tabular-nums">
              {draftScope && draftScope.total > 0 ? `${draftScope.landed}/${draftScope.total} landed` : null}
            </span>
            <EtaCell eta={draftScope?.forecast ? etaOfForecast(draftScope.forecast, clock) : null} clock={clock} />
          </li>
        ) : null}
      </ul>
    </section>
  );
}
