"use client";

// The project's needs-you rows on its dashboard, as the one needs-you read model answers them
// (`GET /api/projects/:id/needs-you`); the same rows the development overview and the inbox show.

import { NeedsYouList, needsYouGroups } from "@/features/needs-you/components/needs-you-list";
import type { NeedsYouItem } from "@/features/needs-you/types";
import { SectionTitle } from "@/design/primitives/heading";

export function AttentionQueue({ items, slug }: { items: NeedsYouItem[]; slug: string }) {
  // the header counts the rows the groups draw, taken from the same grouping the list uses
  const drawn = needsYouGroups(items).reduce((n, g) => n + g.rows.length, 0);
  return (
    <section aria-label="Needs you" data-testid="dashboard-needs-you">
      <SectionTitle className="fg-h3 mb-2 text-[var(--accent-text)]">
        Needs you{items.length > 0 ? ` ${drawn}` : ""}
      </SectionTitle>
      <NeedsYouList
        items={items}
        slug={slug}
        foldKey="web-v2:project-dashboard:needs-you"
        empty="Nothing in this project needs you right now."
      />
    </section>
  );
}
