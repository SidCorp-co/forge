"use client";

// The project's needs-you rows on its dashboard, as the one needs-you read model answers them
// (`GET /api/projects/:id/needs-you`); the same rows the development overview and the inbox show.
// Identical acts — a requirement following a design that has a newer approved revision — fold into one
// line that opens the list, each row keeping its own act.

import { FOLLOW_NEWER_DESIGN_ACT } from "@forge/contracts/requirements";
import { NeedsYouList, needsYouGroups } from "@/features/needs-you/components/needs-you-list";
import type { NeedsYouItem } from "@/features/needs-you/types";
import { SectionTitle } from "@/design/primitives/heading";

const followsNewerDesign = (n: NeedsYouItem) => n.entity === "requirement" && n.waitingOn.act.startsWith(FOLLOW_NEWER_DESIGN_ACT);

export function AttentionQueue({ items, slug }: { items: NeedsYouItem[]; slug: string }) {
  // the header counts the rows the groups draw, taken from the same grouping the list uses
  const drawn = needsYouGroups(items).reduce((n, g) => n + g.rows.length, 0);
  const follows = items.filter(followsNewerDesign);
  const folded = follows.length > 1 ? follows : [];
  const rest = folded.length > 0 ? items.filter((n) => !followsNewerDesign(n)) : items;
  return (
    <section aria-label="Needs you" data-testid="dashboard-needs-you">
      <SectionTitle className="fg-h3 mb-2 text-[var(--accent-text)]">
        Needs you{items.length > 0 ? ` ${drawn}` : ""}
      </SectionTitle>
      {rest.length > 0 || folded.length === 0 ? (
        <NeedsYouList
          items={rest}
          slug={slug}
          foldKey="web-v2:project-dashboard:needs-you"
          empty="Nothing in this project needs you right now."
        />
      ) : null}
      {folded.length > 0 ? (
        <details className="border-b border-line-subtle" data-testid="follow-design-fold">
          <summary className="cursor-pointer select-none px-5 py-2.5 text-13 font-semibold text-link hover:underline max-md:px-3">
            {folded.length} requirements follow a design with a newer approved revision — review
          </summary>
          <NeedsYouList items={folded} slug={slug} foldKey="web-v2:project-dashboard:needs-you-follow" empty="" />
        </details>
      ) : null}
    </section>
  );
}
