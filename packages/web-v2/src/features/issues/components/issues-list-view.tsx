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
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { usePathname } from "next/navigation";
// Issues List view (the "List" tab of the redesigned Issues screen, ISS-364).
// Server-side search / filter / sort / pagination via the search endpoint,
// per-row lazy cost + dep badges, inline edit (transition + patch), pin-this-
// view, and the desktop table / mobile card split. Live via WS
// (`['issues','search']` invalidated by the event-router). ISS-293.
//
// URL-as-state (ISS-436): every filter (q / filter / priority / assignee /
// groupBy / sort / page) is DERIVED from the live query string via
// `useLocationSearch`, and the setters write back with a shallow
// `replaceState` MERGE (never a rebuild — the host's `?tab=` and any sibling
// param survive, ISS-364/331). Because derivation is reactive, an external URL
// change — a pinned-view click on this same route, back/forward — restores the
// exact view without a remount (the old hydrate-once useState went stale).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ISSUES_PAGE_SIZE } from "../api";
import { groupRows, priorityLabel } from "../derive";
import {
  useIssues,
  usePatchIssue,
  useProjectMembers,
  useTransitionIssue,
} from "../hooks";
import {
  type GroupBy,
  ISSUE_PRIORITIES,
  type IssueFilter,
  type IssuePriority,
  type IssueSort,
} from "../types";
import { IssueMobileCard, IssueTableRow } from "./issue-row-actions";
import type { RowActions } from "./issue-table-row";

// "All" includes drafts (ISS-360 — no "All + drafts" split). Draft and Done are
// explicit narrowing buckets (ISS-438): pipeline order left→right, with the
// not-yet-started and shipped ends on the edges. Stale
// `?filter=everything|drafts` deep-links fall back to "all".
const FILTERS: SegmentOption<IssueFilter>[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];
const VALID_FILTERS: IssueFilter[] = ["all", "draft", "active", "review", "blocked", "done"];

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

// Server-backed extra filters (ISS-436) — the search endpoint always supported
// `priority`/`assignee`; these expose them. "" = no filter.
const PRIORITY_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "Priority: any" },
  ...ISSUE_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) })),
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

  // ── URL = single source of truth for every filter (ISS-436) ───────────────
  const search = useLocationSearch();
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const q = sp.get("q") ?? "";
  const rawFilter = decodeFilter<IssueFilter>(sp, "filter", "all");
  const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : "all";
  const rawPriority = sp.get("priority") ?? "";
  const priority = (ISSUE_PRIORITIES as string[]).includes(rawPriority)
    ? (rawPriority as IssuePriority)
    : undefined;
  const assignee = sp.get("assignee") ?? "";
  const groupBy = decodeFilter<GroupBy>(sp, "groupBy", "none");
  const sort = decodeFilter<IssueSort>(sp, "sort", "createdAt:desc");
  const page = decodeNumber(sp, "page", 1);

  /** Shallow-merge `patch` into the live query string ("" deletes the key).
   *  Guarded to the issues route so an in-flight navigation to a child route
   *  is never clobbered (ISS-332). */
  const setParams = useCallback(
    (patch: Record<string, string>) => {
      if (typeof window === "undefined") return;
      if (!window.location.pathname.endsWith("/issues")) return;
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${pathname}${qs ? `?${qs}` : ""}`,
      );
    },
    [pathname],
  );

  // Search box: local state for keystrokes, debounced (~300ms) into the URL's
  // `q`. Follows external URL changes (pinned-view click, back/forward).
  const [rawQ, setRawQ] = useState(q);
  const lastAppliedQ = useRef(q);
  useEffect(() => {
    if (q !== lastAppliedQ.current) {
      lastAppliedQ.current = q;
      setRawQ(q);
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = rawQ.trim();
      if (v === q) return;
      lastAppliedQ.current = v;
      setParams({ q: v, page: "" });
    }, 300);
    return () => clearTimeout(t);
  }, [rawQ, q, setParams]);

  // ── Pin this view (ISS-436: named pins, filters included) ──────────────────
  // The pinnable href is simply the current URL (filters + `?tab=` live there
  // already); `?new=1` (the New-issue deep-link) is stripped so a pin never
  // reopens the dialog.
  const viewHref = useMemo(() => {
    const p = new URLSearchParams(search);
    p.delete("new");
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  }, [pathname, search]);
  const isPinned = pinnedViews.isPinned(viewHref);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinName, setPinName] = useState("");
  const defaultPinLabel = `Issues${filter !== "all" ? ` · ${filter}` : ""}${q ? ` · "${q}"` : ""}`;

  function onPinClick() {
    if (isPinned) {
      pinnedViews.remove(viewHref);
      return;
    }
    setPinName(defaultPinLabel);
    setPinOpen(true);
  }
  function confirmPin() {
    pinnedViews.toggle({
      id: viewHref,
      label: pinName.trim() || defaultPinLabel,
      icon: "list",
      href: viewHref,
    });
    setPinOpen(false);
  }

  useRoom(projectRoom(projectId));

  const issuesQ = useIssues(projectId, {
    q,
    filter,
    priority,
    assignee: assignee || undefined,
    sort,
    page,
    pageSize: ISSUES_PAGE_SIZE,
  });
  const membersQ = useProjectMembers(projectId);
  const patch = usePatchIssue();
  const transition = useTransitionIssue();

  const assigneeFilterOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "Assignee: anyone" },
      ...(membersQ.data ?? []).map((m) => ({ value: m.userId, label: m.email })),
    ],
    [membersQ.data],
  );

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

  const isFiltered = q !== "" || filter !== "all" || !!priority || !!assignee;

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
            onChange={(v) =>
              setParams({ filter: v !== "all" ? v : "", page: "" })
            }
          />
        </div>
        <Select
          aria-label="Priority filter"
          value={priority ?? ""}
          options={PRIORITY_FILTER_OPTIONS}
          onChange={(v) => setParams({ priority: v, page: "" })}
          className="w-36"
        />
        <Select
          aria-label="Assignee filter"
          value={assignee}
          options={assigneeFilterOptions}
          onChange={(v) => setParams({ assignee: v, page: "" })}
          className="w-44"
        />
        <Select
          aria-label="Group by"
          value={groupBy}
          options={GROUP_OPTIONS}
          onChange={(v) => setParams({ groupBy: v !== "none" ? v : "" })}
          className="w-40"
        />
        <Select
          aria-label="Sort"
          value={sort}
          options={SORT_OPTIONS}
          onChange={(v) =>
            setParams({ sort: v !== "createdAt:desc" ? v : "", page: "" })
          }
          className="w-44"
        />
        <div className="relative ml-auto">
          <Button
            variant={isPinned ? "secondary" : "ghost"}
            size="sm"
            icon="pin"
            aria-pressed={isPinned}
            onClick={onPinClick}
          >
            {isPinned ? "Pinned" : "Pin view"}
          </Button>
          {pinOpen && (
            <>
              {/* Click-away backdrop. */}
              <button
                type="button"
                aria-label="Close"
                tabIndex={-1}
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setPinOpen(false)}
              />
              <div
                role="dialog"
                aria-label="Pin this view"
                className="absolute right-0 top-full z-20 mt-2 w-72 rounded-lg border border-line bg-surface p-3 shadow-lg"
              >
                <p className="fg-caption mb-2 text-muted">
                  Pin this view — current filters are saved with it.
                </p>
                <Input
                  value={pinName}
                  onChange={(e) => setPinName(e.target.value)}
                  placeholder={defaultPinLabel}
                  aria-label="Pin name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmPin();
                    if (e.key === "Escape") setPinOpen(false);
                  }}
                />
                <div className="mt-2.5 flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setPinOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={confirmPin}>
                    Pin
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
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
              table needs horizontal scroll under ~1100px (ISS-308 C3). */}
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
                        {/* ISS-436: ONE status column — lifecycle chip + live
                            agent indicator + mini stage tracker. The old
                            separate Pipeline/Status pair rendered the same two
                            fields twice. */}
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
                onChange={(p) => setParams({ page: p > 1 ? String(p) : "" })}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
