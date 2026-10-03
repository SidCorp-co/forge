"use client";

// The peek (`?peek=ISS-12`) beside the grouped views: the shared PeekPanel holding the issue's
// header, whose turn it is and the read model's facts. It reads the row the list already holds;
// the full page adds the properties, description, plan and history.

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { PeekHead, PeekPanel, type PeekState } from "@/design";
import { IssueBanner, IssueStandingFacts, issueBadge } from "./issue-standing-bits";

export function IssuePeek({ slug, row, peek, onOpenFull }: { slug: string; row: IssueStandingRow; peek: PeekState; onOpenFull: () => void }) {
  return (
    <PeekPanel peek={peek} listLabel="Issues" noun="Issue" onOpenFull={onOpenFull} testId="issue-peek">
      <PeekHead noun="Issue" itemKey={row.key} badge={issueBadge(row)} title={row.title} />
      <IssueBanner standing={row.standing} className="px-[18px]" />
      <div className="px-[18px] pb-4 pt-4">
        <IssueStandingFacts row={row} slug={slug} />
      </div>
    </PeekPanel>
  );
}
