// The change requests a release merges (REQ-63 BC-5): each in its place in the declared order, its
// host link, where it stands, and the issues it delivers. Flat: one hairline-divided list, no boxes.

import { type ChangeRequestState, changeRequestLabel } from "@forge/contracts/releases";
import { Link } from "@/lib/navigation/router";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { cn } from "@/lib/utils/cn";
import type { ReleaseIssueView } from "../types";

/** One change request as the list draws it. */
export interface ChangeRequestItem {
  label: string;
  url: string | null;
  state: ChangeRequestState;
  order: number | null;
  issues: string[];
  title?: string | undefined;
}

const STATE_TONE: Record<ChangeRequestState, string> = {
  open: "text-you-11",
  merged: "text-ok-11",
  closed: "text-subtle",
};

/** The requests a release's issues are delivered by, each once, in the release's order. */
export function changeRequestItems(issues: readonly Pick<ReleaseIssueView, "key" | "changeRequest">[]): ChangeRequestItem[] {
  const byLabel = new Map<string, ChangeRequestItem>();
  for (const i of issues) {
    const cr = i.changeRequest;
    if (!cr) continue;
    const label = changeRequestLabel(cr);
    const held = byLabel.get(label) ?? { label, url: cr.url, state: cr.state, order: cr.order, issues: [], title: cr.title };
    held.issues.push(i.key);
    byLabel.set(label, held);
  }
  return [...byLabel.values()].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label, "en", { numeric: true }),
  );
}

export function ChangeRequestList({ items, slug, className }: { items: readonly ChangeRequestItem[]; slug: string; className?: string }) {
  const t = useCopy();
  if (items.length === 0) return null;
  return (
    <ol className={cn("divide-y divide-line-subtle border-y border-line-subtle text-13", className)} data-testid="release-merges">
      {items.map((cr) => (
        <li key={cr.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2" data-testid="release-merge" data-state={cr.state}>
          <span className="w-5 flex-none text-right font-mono text-12 text-subtle">{cr.order ?? "–"}</span>
          {cr.url ? (
            <a href={cr.url} target="_blank" rel="noreferrer" className="font-mono font-medium text-link hover:underline" title={cr.title}>
              {cr.label}
            </a>
          ) : (
            <span className="font-mono font-medium text-fg" title={cr.title}>
              {cr.label}
            </span>
          )}
          <span className={cn("text-12", STATE_TONE[cr.state])}>{t(`releases.merges.state.${cr.state}`)}</span>
          {cr.title ? <span className="min-w-0 flex-1 truncate text-muted max-md:basis-full max-md:pl-8">{cr.title}</span> : <span className="flex-1 max-md:hidden" />}
          <span className="flex flex-wrap gap-x-2 font-mono text-12 max-md:basis-full max-md:pl-8">
            {cr.issues.map((key) => (
              <Link key={key} href={issueHref(slug, key)} className="text-link hover:underline">
                {key}
              </Link>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The release page's merge list, under its heading; nothing where the release merges no request. */
export function ReleaseMerges({ issues, slug }: { issues: readonly Pick<ReleaseIssueView, "key" | "changeRequest">[]; slug: string }) {
  const t = useCopy();
  const items = changeRequestItems(issues);
  if (items.length === 0) return null;
  const ordered = items.some((i) => i.order !== null);
  return (
    <section className="border-b border-line-subtle px-8 py-3 max-md:px-4" data-testid="release-merges-section">
      <h2 className="mb-1.5 text-11-5 font-semibold uppercase tracking-wide text-subtle">
        {t(ordered ? "releases.merges.title" : "releases.merges.linked")}
      </h2>
      <ChangeRequestList items={items} slug={slug} />
    </section>
  );
}
