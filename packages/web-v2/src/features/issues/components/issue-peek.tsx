"use client";

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { PeekHead, PeekPanel, type PeekState } from "@/design";
import { IssueBanner, IssuePeekFacts, IssueStrip, issueBadge } from "./issue-standing-bits";

export function IssuePeek({ slug, row, peek, onOpenFull }: { slug: string; row: IssueStandingRow; peek: PeekState; onOpenFull: () => void }) {
  return (
    <PeekPanel peek={peek} listLabel="Issues" noun="Issue" onOpenFull={onOpenFull} testId="issue-peek">
      <PeekHead noun="Issue" itemKey={row.key} badge={issueBadge(row)} title={row.title} />
      <div className="px-[18px] pb-3">
        <IssueStrip standing={row.standing} />
      </div>
      <IssueBanner standing={row.standing} className="mx-[18px] rounded-md" />
      <div className="px-[18px] pb-4 pt-2">
        <IssuePeekFacts row={row} slug={slug} />
      </div>
    </PeekPanel>
  );
}
