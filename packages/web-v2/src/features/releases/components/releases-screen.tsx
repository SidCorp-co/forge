"use client";

import { RELEASE_ATTENTION_GROUPS, RELEASE_ATTENTION_LABELS } from "@forge/contracts/releases";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { ListFilterBar, useListNarrowing } from "@/features/chat-dock";
import {
  ActorChip,
  EmptyState,
  GroupedList,
  type ListGroup,
  standingGroups,
  type ListRowView,
  PageTitle,
  StatusBadge,
  useListPage,
  WaitingOn,
  ListPage,
  ListSearch,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useReleases } from "../hooks";
import { RELEASES_LIST, releaseHref } from "@/lib/routes/releases";
import type { ReleaseSummary } from "../types";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useComingNext } from "@/features/forecast";
import { ComingNext } from "./coming-next";
import { ReleasePeek } from "./release-peek";
import { ReleaseTrain } from "./release-train";

type Label = ReturnType<typeof useLabel>;
type Time = ReturnType<typeof useTimeFormat>;

const groupsOf = (rows: ReleaseSummary[], label: Label): ListGroup<ReleaseSummary>[] =>
  standingGroups(
    rows,
    RELEASE_ATTENTION_GROUPS,
    Object.fromEntries(
      RELEASE_ATTENTION_GROUPS.map((g) => {
        const v = RELEASE_ATTENTION_LABELS[g];
        return [g, { ...v, label: label("releaseAttention", g), hint: v.hint ? label("releaseAttentionHint", g) : null }];
      }),
    ) as typeof RELEASE_ATTENTION_LABELS,
  );

const requirementsOf = (r: ReleaseSummary, t: Copy) => (r.requirements.length > 0 ? r.requirements.join(", ") : t("releases.maintenance"));

const rowOf =
  (slug: string, t: Copy, time: Time) =>
  (r: ReleaseSummary): ListRowView => ({
    key: r.version,
    href: releaseHref(slug, r.version),
    title: r.headline || t("releases.releaseVersion", { version: r.version }),
    facts: [
      t("releases.issuesCount", { n: r.issueCount }),
      requirementsOf(r, t),
      r.criteria.total === 0 ? t("releases.noCriteria") : t("releases.criteriaProven", { proven: r.criteria.proven, total: r.criteria.total }),
      ...(r.cutCount > 1 ? [t("releases.attemptsCount", { n: r.cutCount })] : []),
      ...(r.current ? [t("releases.servingProduction")] : []),
    ],
    state: <StatusBadge family="releaseState" value={r.state} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: r.owner ? <ActorChip name={r.owner.name} kind={r.owner.kind} size={20} /> : null,
    age: { text: time.relative(r.at), title: t("releases.lastChanged", { at: time.dateTime(r.at) }) },
    dim: r.attentionGroup === "done" || r.attentionGroup === "stopped",
  });

export function ReleasesScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const q = useReleases(projectId);
  const comingQ = useComingNext(projectId);
  const clock = useEtaClock();
  // whom a release waits on and its state are the list filter the chat sets too (REQ-41 BC-5)
  const filter = useListNarrowing("releases");
  const all = q.data?.releases ?? [];
  const list = useListPage({
    rows: all,
    keyOf: (r) => r.version,
    searchOf: (r) => `${r.version} ${r.headline} ${r.requirements.join(" ")}`,
    narrow: (r) => matchesListFilter(filter, { waiting: waitingFilterOf(r), text: "", state: r.state }),
    groupsOf: (rows) => groupsOf(rows, label),
    foldKey: "web-v2:releases-fold",
    hrefOf: (version) => releaseHref(slug, version),
    origin: RELEASES_LIST,
  });
  const { peek } = list;

  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingList")} title={<PageTitle>{t("releases.title")}</PageTitle>} height="60vh" retry="always">
      {({ production }) => (
        <ListPage
          testId="releases-screen"
          title={t("releases.title")}
          toolbar={
            <>
              <ListSearch noun={t("releases.searchNoun")} {...list.search} />
              <ListFilterBar list="releases" />
              {production.ok ? null : (
                <span className="text-12 text-muted" title={production.reason} data-testid="production-unreadable">
                  {t("releases.productionUnreadable")}
                </span>
              )}
            </>
          }
          peek={peek.open ? <ReleasePeek key={peek.open} projectId={projectId} version={peek.open} peek={peek} onOpenFull={() => list.openFull(peek.open as string)} /> : null}
        >
          <ComingNext next={comingQ.data} draft={all.find((r) => r.state === "draft")} slug={slug} clock={clock} />
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState message={t("releases.emptyTitle")} />
            </div>
          ) : (
            <>
              <ReleaseTrain releases={all} slug={slug} selected={peek.open ?? undefined} />
              <GroupedList
                ariaLabel={t("releases.title")}
                groups={list.groups}
                fold={list.fold}
                row={rowOf(slug, t, time)}
                selected={peek.open}
                onPeek={list.togglePeek}
                empty={t("releases.noMatch")}
                columns={{ meta: list.rows.some((r) => r.owner) ? t("list.col.meta") : t("releases.colAge") }}
              />
            </>
          )}
        </ListPage>
      )}
    </QueryBoundary>
  );
}
