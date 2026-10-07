"use client";

// What comes next, on top of Releases: each requirement with work still to land and when it is in
// people's hands (core's `forecast/scope.ts:readComingNext`), then the draft and the act it waits on
// (core's release read model). Flush rows on hairlines; the reasons sit in the tooltips.

import type { ComingNextForecast } from "@forge/contracts/forecast";
import Link from "next/link";
import { ViewHeading } from "@/design";
import { deliveryText, scopeText } from "@/features/forecast/text";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseSummary } from "../types";

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle px-5 py-2 max-md:px-3";

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
  now = Date.now(),
}: {
  next: ComingNextForecast | undefined;
  draft: ReleaseSummary | undefined;
  slug: string;
  now?: number;
}) {
  const requirements = next?.requirements ?? [];
  if (requirements.length === 0 && !draft) return null;
  const turn = draft ? draftTurnText(draft) : null;
  const landed = next?.draft.forecast ? scopeText(next.draft, now, { next: false }) : null;
  return (
    <section aria-label="Coming next" className="pt-4" data-testid="coming-next">
      <div className="px-5 max-md:px-3">
        <ViewHeading hint="Open work per requirement, and when it is in people's hands">Coming next</ViewHeading>
      </div>
      <ul className="m-0 list-none border-t border-line-subtle p-0">
        {requirements.map((s) => {
          const read = s.delivery ? deliveryText(s.delivery, now) : null;
          return (
            <li key={s.key} className={ROW} data-testid="coming-next-requirement" data-key={s.key}>
              <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={requirementHref(slug, s.key)}>
                {s.key}
              </Link>
              <span className="min-w-0 flex-1 truncate text-13 text-fg max-md:basis-full">{s.title}</span>
              <span className="text-12 text-muted tabular-nums">
                {s.landed}/{s.total} landed
              </span>
              {read ? (
                <span className="fg-body-sm text-muted" title={read.detail} data-testid="coming-next-line">
                  {read.line}
                </span>
              ) : null}
            </li>
          );
        })}
        {draft ? (
          <li className={ROW} data-testid="coming-next-draft" data-key={draft.key}>
            <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={releaseHref(slug, draft.version)}>
              {draft.version}
            </Link>
            <span className="min-w-0 flex-1 text-13 text-fg max-md:basis-full">Draft release · Issues {draft.issueCount}</span>
            {landed ? (
              <span className="fg-body-sm text-muted" title={landed.detail} data-testid="coming-next-draft-line">
                {landed.line}
              </span>
            ) : null}
            {turn ? (
              <span className="text-12-5 font-semibold text-fg" title={draft.waitingOn.rule} data-testid="coming-next-draft-turn">
                {turn}
              </span>
            ) : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
