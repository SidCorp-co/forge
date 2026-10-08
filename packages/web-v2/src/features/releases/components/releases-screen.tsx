"use client";

import { RELEASE_ATTENTION_GROUPS, RELEASE_ATTENTION_LABELS } from "@forge/contracts/releases";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  ActorChip,
  EmptyState,
  GroupedList,
  Icon,
  type ListGroup,
  standingGroups,
  type ListRowView,
  PageTitle,
  rememberListOrigin,
  StatusBadge,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  visibleRows,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useReleases } from "../hooks";
import { RELEASES_LIST, releaseHref } from "@/lib/routes/releases";
import type { ReleaseSummary } from "../types";
import { useComingNext, useEtaClock } from "@/features/forecast/hooks";
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
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const text = params.get("q") ?? "";
  const fold = useGroupFold("web-v2:releases-fold");
  const all = q.data?.releases ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.version} ${r.headline} ${r.requirements.join(" ")}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, label), [rows, label]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.version), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.version), [all]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => rowOf(slug, t, time), [slug, t, time]);
  const openFull = useCallback(
    (version: string) => {
      rememberListOrigin(RELEASES_LIST);
      router.push(releaseHref(slug, version));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = <PageTitle>{t("releases.title")}</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingList")} title={title} height="60vh" retry="always">
      {(data) => {
        const production = data.production;
        return (
          <div className="grid min-h-full content-start bg-app" data-testid="releases-screen">
            {title}
            <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
              <div className="min-w-0">
                <SearchBar
                  text={text}
                  onText={(q) => setParams({ q: q || null })}
                  productionUnreadable={production.ok ? null : production.reason}
                />
                <ComingNext next={comingQ.data} draft={all.find((r) => r.state === "draft")} slug={slug} clock={clock} />
                {all.length === 0 ? (
                  <div className="px-5 py-10">
                    <EmptyState title={t("releases.emptyTitle")} message={t("releases.emptyMessage")} />
                  </div>
                ) : (
                  <>
                    <ReleaseTrain releases={all} slug={slug} selected={peek.open ?? undefined} />
                    <GroupedList
                      ariaLabel={t("releases.title")}
                      groups={groups}
                      fold={fold}
                      row={row}
                      selected={peek.open}
                      onPeek={(k) => peek.set(k === peek.open ? null : k)}
                      empty={t("releases.noMatch")}
                      columns={{ meta: rows.some((r) => r.owner) ? t("list.col.meta") : t("releases.colAge") }}
                    />
                  </>
                )}
              </div>
              {peek.open ? <ReleasePeek key={peek.open} projectId={projectId} version={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} /> : null}
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}

function SearchBar({
  text,
  onText,
  productionUnreadable,
}: {
  text: string;
  onText: (q: string) => void;
  /** Why production cannot be read, or null when it can. */
  productionUnreadable: string | null;
}) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
      <label className="flex h-[30px] min-w-[150px] max-w-[260px] flex-1 items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 text-12-5 text-subtle max-md:h-10 max-md:max-w-none max-md:basis-full">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label={t("releases.searchLabel")}
          placeholder={t("releases.searchPlaceholder")}
          defaultValue={text}
          onChange={(e) => onText(e.target.value)}
          className="w-full min-w-0 border-0 bg-transparent text-fg outline-none"
        />
      </label>
      {productionUnreadable === null ? null : (
        <span className="text-12 text-muted" title={productionUnreadable} data-testid="production-unreadable">
          {t("releases.productionUnreadable")}
        </span>
      )}
    </div>
  );
}
