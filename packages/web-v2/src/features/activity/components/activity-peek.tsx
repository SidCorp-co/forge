// One project's activity beside the list (ISS-951, MK-8): what is in flight at its step, what its
// master takes next, what waits on the reader, and its next release. Titles only; each item's key is
// its tooltip, and the project's page is the peek's full page.

import type { OrgActivityProject, OrgActivityRelease } from "@forge/contracts/org-activity";
import type { ReactNode } from "react";
import { EnumBadge, type FullPage, LEGEND, PeekHead, PeekPanel, type PeekState, RowItem, RowList, StatusBadge, useNow } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { formatAge } from "@/lib/utils/format";

/** Shipped (solid) over shipped-or-awaiting (lighter), and `shipped/total`; the scope's name on hover. */
export function ReleaseBar({ release }: { release: OrgActivityRelease }) {
  const t = useCopy();
  const pct = (n: number) => (release.total > 0 ? Math.round((n / release.total) * 100) : 0);
  const name = release.title ?? t("activity.release.draft");
  return (
    <span className="inline-flex items-center gap-2" title={name} data-testid="activity-release">
      <span
        role="img"
        aria-label={t("activity.release.progress", { name, shipped: release.shipped, total: release.total })}
        className="relative block h-1 w-14 flex-none overflow-hidden rounded-pill bg-sunken"
      >
        <span className="absolute inset-y-0 left-0 bg-accent-7" style={{ width: `${pct(release.shipped + release.awaitingRelease)}%` }} />
        <span className="absolute inset-y-0 left-0 bg-ok-9" style={{ width: `${pct(release.shipped)}%` }} />
      </span>
      <span aria-hidden className="font-mono text-12 tabular-nums text-muted">
        {release.shipped}/{release.total}
      </span>
    </span>
  );
}

function Part({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section className="px-4.5 pt-4" aria-label={label}>
      <h3 className="flex items-baseline justify-between pb-1.5 text-11-5 font-semibold uppercase tracking-wide text-subtle">
        {label}
        {count > 0 ? <span className="font-mono normal-case tracking-normal">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Nothing() {
  return <p className="py-1.5 text-13 text-subtle">—</p>;
}

export function ActivityPeek({ row, peek, full }: { row: OrgActivityProject; peek: PeekState; full: FullPage }) {
  const t = useCopy();
  const now = useNow(30_000);
  return (
    <PeekPanel peek={peek} listLabel={t("activity.title")} noun={t("activity.noun")} full={full} testId="activity-peek">
      <PeekHead noun={t("activity.noun")} itemKey="" badge={<StatusBadge family="masterState" value={row.master.state} />} title={row.name} />
      <Part label={t("activity.col.now")} count={row.now.length}>
        {row.now.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.now")}>
            {row.now.map((n) => (
              <RowItem
                key={n.issueId}
                rowKey={n.issueId}
                title={n.title}
                tip={n.key}
                href={issueHref(row.slug, n.key)}
                trailing={
                  <>
                    {n.step ? <EnumBadge family="step" value={n.step} /> : <StatusBadge family="issue" value={n.status} />}
                    {n.stepSince ? (
                      <span className="font-mono text-11-5 text-subtle" title={t("activity.stepSince")}>
                        {formatAge(n.stepSince, now)}
                      </span>
                    ) : null}
                  </>
                }
              />
            ))}
          </RowList>
        )}
      </Part>
      <Part label={t("activity.col.next")} count={row.next.total}>
        {row.next.items.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.next")}>
            {row.next.items.map((n) => (
              <RowItem
                key={n.issueId}
                rowKey={n.issueId}
                title={n.title}
                tip={n.key}
                href={issueHref(row.slug, n.key)}
                trailing={n.priority ? <EnumBadge family="priority" value={n.priority} /> : null}
              />
            ))}
          </RowList>
        )}
      </Part>
      <Part label={t("activity.col.people")} count={row.people.total}>
        {row.people.items.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.people")}>
            {row.people.items.map((d) => (
              <RowItem
                key={`${d.group}:${d.key}`}
                rowKey={d.key}
                title={d.title || d.key}
                tip={d.key}
                href={`${full.href}/approvals`}
                trailing={<span className="text-12 font-medium" style={{ color: LEGEND.you.fg }}>{t(`activity.people.${d.group}`)}</span>}
              />
            ))}
          </RowList>
        )}
      </Part>
      {row.release ? (
        <Part label={t("activity.col.release")} count={0}>
          <div className="flex items-center justify-between gap-3 pb-4">
            <span className="min-w-0 truncate text-13">{row.release.title ?? t("activity.release.draft")}</span>
            <ReleaseBar release={row.release} />
          </div>
        </Part>
      ) : null}
    </PeekPanel>
  );
}
