"use client";

import type { Forecast } from "@forge/contracts/forecast";
import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { PeekHead, PeekPanel, type PeekState } from "@/design";
import type { EtaClock } from "@/features/forecast/eta";
import { useCopy } from "@/lib/i18n/interface-language";
import { IssueBanner, IssuePeekFacts, IssueStrip, issueBadge } from "./issue-standing-bits";
import { Written } from "@/lib/i18n/written";

export function IssuePeek({
  slug,
  row,
  forecast,
  clock,
  peek,
  onOpenFull,
}: {
  slug: string;
  row: IssueStandingRow;
  forecast?: Forecast | undefined;
  clock: EtaClock;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  return (
    <PeekPanel peek={peek} listLabel={t("issues.screen.title")} noun={t("issues.noun")} onOpenFull={onOpenFull} testId="issue-peek">
      <PeekHead noun={t("issues.noun")} itemKey={row.key} badge={issueBadge(row)} title={<Written text={row.title} lang={row.writtenLang} />} />
      <div className="px-[18px] pb-3">
        <IssueStrip standing={row.standing} />
      </div>
      <IssueBanner standing={row.standing} className="mx-[18px] rounded-md" />
      <div className="px-[18px] pb-4 pt-2">
        <IssuePeekFacts row={row} slug={slug} forecast={forecast} clock={clock} />
      </div>
    </PeekPanel>
  );
}
