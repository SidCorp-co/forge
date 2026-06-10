"use client";

import {
  BoardRowSkeleton,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  type SegmentOption,
  SegmentedControl,
  Select,
  type SelectOption,
  TBody,
  TH,
  THead,
  TR,
  Table,
} from "@/design";
import { decodeFilter, decodeNumber, usePinnedViews } from "@/features/shell";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { usePathname } from "next/navigation";
// Issues List view (the "List" tab of the redesigned Issues screen, ISS-364).
// Extracted verbatim from the former single-view `IssuesScreen` body: server-
// side search / filter / sort / pagination via the search endpoint, per-row
// lazy cost + dep badges, inline edit (transition + patch), pin-this-view, and
// the desktop table / mobile card split. Live via WS (`['issues','search']`
// invalidated by the event-router). ISS-293.
//
// URL-sync note (ISS-364): this view MERGES its filter params into the current
// query string (never rebuilds it) so the host screen's `?tab=` survives a
// filter change — rebuilding from scratch would drop the active-view param.
import { useEffect, useMemo, useRef, useState } from "react";
import { ISSUES_PAGE_SIZE } from "../api";
import { groupRows } from "../derive";
import {
  useIssues,
  usePatchIssue,
  useProjectMembers,
  useTransitionIssue,
} from "../hooks";
import type { GroupBy, IssueFilter, IssueSort } from "../types";
import { IssueMobileCard, IssueTableRow } from "./issue-row-actions";
import type { RowActions } from "./issue-table-row";

// ISS-360: four tabs only. "All" now includes drafts (no separate Drafts /
// "All + drafts" tabs — that split was the confusing behaviour the reporter
// flagged). Stale `?filter=everything|drafts` deep-links fall back to "all".
const FILTERS: SegmentOption<IssueFilter>[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
];
const VALID_FILTERS: IssueFilter[] = ["all", "active", "review", "blocked"];

const GROUP_OPTIONS: SelectOption[] = [
  { value: "none", label: "No grouping" },
  { value: "status", label: "Group: status" },
  { value: "priority", label: "Group: priority" },
  { value: "assignee", label: "Group: assignee" },
];

const SORT_OPTIONS: SelectOption[] = [
  { value: "createdAt:desc", label: "Newest" },
  { value: "createdAt:asc", label: "Oldest" },
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "priority:desc", label: "Priority ↓" },
  { value: "priority:asc", label: "Priority ↑" },
];

interface IssuesListViewProps {
  scope: { projectId: string; slug: string };
  /** Open the New-issue dialog (owned by the host screen). */
  onNewIssue?: () => void;
  /** False for project viewers (read-only): row quick-action mutations
   *  (transition / priority / complexity / assign) are hidden. Optional,
   *  defaults true so other callers keep their behaviour. */
  canWrite?: boolean;
}

export function IssuesListView({
  scope,
  onNewIssue,
  canWrite = true,
}: IssuesListViewProps) {
  const { projectId, slug } = scope;
  const pathname = usePathname() || `/projects/${slug}/issues`;
  const pinnedViews = usePinnedViews();
  const [rawQ, setRawQ] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sort, setSort] = useState<IssueSort>("createdAt:desc");
  const [page, setPage] = useState(1);
  // Gate URL-sync until the initial hydrate-from-URL has run, so we don't clobber
  // a deep-link's query on first paint.
  const hydrated = useRef(false);

  // Hydrate filter state from the URL once on mount. This makes pinned-view
  // deep-links (route + ?filters) restore the exact view. Read from
  // window.location to avoid forcing a Suspense boundary around the screen.
  useEffect(() => {
    const sp =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    if (sp) {
      const qv = sp.get("q") ?? "";
      setRawQ(qv);
      setQ(qv);
      const decodedFilter = decodeFilter<IssueFilter>(sp, "filter", "all");
      setFilter(VALID_FILTERS.includes(decodedFilter) ? decodedFilter : "all");
      setGroupBy(decodeFilter<GroupBy>(sp, "groupBy", "none"));
      setSort(decodeFilter<IssueSort>(sp, "sort", "createdAt:desc"));
      setPage(decodeNumber(sp, "page", 1));
    }
    hydrated.current = true;
  }, []);

  // Debounce the search box (~300ms) → server `q`.
  useEffect(() => {
    const t = setTimeout(() => setQ(rawQ.trim()), 300);
    return () => clearTimeout(t);
  }, [rawQ]);

  // Any filter/search/sort change resets to page 1 (after the initial hydrate).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    if (hydrated.current) setPage(1);
  }, [q, filter, sort]);

  // Mirror the current view into the URL (shallow — no navigation / refetch) so
  // it is copy-pasteable and pinnable. MERGE into the live query string so the
  // host's `?tab=list` (and any sibling param) survives a filter change — the
  // old single-view screen rebuilt the string here, which would now wipe `tab`.
  const filterParams = useMemo<Record<string, string>>(
    () => ({
      q: q || "",
      filter: filter !== "all" ? filter : "",
      groupBy: groupBy !== "none" ? groupBy : "",
      sort: sort !== "createdAt:desc" ? sort : "",
      page: page > 1 ? String(page) : "",
    }),
    [q, filter, groupBy, sort, page],
  );
  useEffect(() => {
    if (!hydrated.current || typeof window === "undefined") return;
    // Only sync while we're still on the issues list route (avoid clobbering an
    // in-flight navigation to a child route — ISS-332).
    if (!window.location.pathname.endsWith("/issues")) return;
    const sp = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(filterParams)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    const qs = sp.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${qs ? `?${qs}` : ""}`,
    );
  }, [pathname, filterParams]);

  // Build the pinnable href from the merged params (carry `tab` so the pinned
  // link reopens the List view).
  const viewHref = useMemo(() => {
    const sp =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
    for (const [key, value] of Object.entries(filterParams)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    const qs = sp.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  }, [pathname, filterParams]);
  const isPinned = pinnedViews.isPinned(viewHref);

  useRoom(projectRoom(projectId));

  const issuesQ = useIssues(projectId, {
    q,
    filter,
    sort,
    page,
    pageSize: ISSUES_PAGE_SIZE,
  });
  const membersQ = useProjectMembers(projectId);
  const patch = usePatchIssue();
  const transition = useTransitionIssue();

  const rows = useMemo(() => issuesQ.data?.items ?? [], [issuesQ.data]);
  const total = issuesQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / ISSUES_PAGE_SIZE));

  const groups = useMemo(
    () => groupRows(rows, groupBy, membersQ.data),
    [rows, groupBy, membersQ.data],
  );

  const actions: RowActions = {
    patch: patch.mutate,
    transition: transition.mutate,
    isPending: patch.isPending || transition.isPending,
    canWrite,
  };

  const isFiltered = q !== "" || filter !== "all";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          icon="search"
          placeholder="Search issues…"
          value={rawQ}
          onChange={(e) => setRawQ(e.target.value)}
          className="w-full sm:w-64"
        />
        <div className="overflow-x-auto">
          <SegmentedControl
            options={FILTERS}
            value={filter}
            onChange={setFilter}
          />
        </div>
        <Select
          aria-label="Group by"
          value={groupBy}
          options={GROUP_OPTIONS}
          onChange={(v) => setGroupBy(v as GroupBy)}
          className="w-40"
        />
        <Select
          aria-label="Sort"
          value={sort}
          options={SORT_OPTIONS}
          onChange={(v) => setSort(v as IssueSort)}
          className="w-44"
        />
        <Button
          variant={isPinned ? "secondary" : "ghost"}
          size="sm"
          icon="pin"
          className="ml-auto"
          aria-pressed={isPinned}
          onClick={() =>
            pinnedViews.toggle({
              id: viewHref,
              label: `Issues${filter !== "all" ? ` · ${filter}` : ""}${q ? ` · "${q}"` : ""}`,
              icon: "list",
              href: viewHref,
            })
          }
        >
          {isPinned ? "Pinned" : "Pin view"}
        </Button>
      </div>

      {issuesQ.isLoading && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {Array.from({ length: 6 }).map((_, i) => (
            <BoardRowSkeleton key={i} />
          ))}
        </div>
      )}

      {issuesQ.isError && (
        <ErrorState
          title="Couldn't load issues"
          message={formatApiError(issuesQ.error)}
          onRetry={() => issuesQ.refetch()}
        />
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length === 0 && (
        <EmptyState
          title={isFiltered ? "Nothing here" : "No issues yet"}
          message={
            isFiltered
              ? "No issues match this search or filter."
              : "Issues for this project will appear here as work is filed."
          }
          mascot={!isFiltered}
          action={
            !isFiltered && onNewIssue
              ? { label: "New issue", onClick: onNewIssue }
              : undefined
          }
        />
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length > 0 && (
        <>
          {/* Desktop only (≥lg): dense table, grouped sections when requested.
              Tablets (768–1024) fall through to the card layout below — the
              9-column table needs horizontal scroll under ~1100px (ISS-308 C3). */}
          <div className="hidden space-y-6 lg:block">
            {groups.map((g) => (
              <section key={g.key}>
                {groupBy !== "none" && (
                  <h2 className="fg-overline mb-2 px-1 font-mono">
                    {g.label} · {g.rows.length}
                  </h2>
                )}
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>ID</TH>
                        <TH>Issue</TH>
                        <TH>Pipeline</TH>
                        <TH>Status</TH>
                        <TH>Priority</TH>
                        <TH>Complexity</TH>
                        <TH className="text-right">Cost</TH>
                        <TH>Assignee</TH>
                        <TH className="sr-only">Actions</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {g.rows.map((row) => (
                        <IssueTableRow
                          key={row.id}
                          row={row}
                          slug={slug}
                          members={membersQ.data}
                          actions={actions}
                        />
                      ))}
                    </TBody>
                  </Table>
                </div>
              </section>
            ))}
          </div>

          {/* Mobile + tablet (<lg): stacked cards. */}
          <div className="space-y-4 lg:hidden">
            {groups.map((g) => (
              <section key={g.key}>
                {groupBy !== "none" && (
                  <h2 className="fg-overline mb-2 px-1 font-mono">
                    {g.label} · {g.rows.length}
                  </h2>
                )}
                <div className="space-y-2.5">
                  {g.rows.map((row) => (
                    <IssueMobileCard
                      key={row.id}
                      row={row}
                      slug={slug}
                      members={membersQ.data}
                      actions={actions}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {pageCount > 1 && (
            <div className="mt-6 flex justify-end">
              <Pagination
                page={page}
                pageCount={pageCount}
                onChange={setPage}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
