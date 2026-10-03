"use client";

// Issues List view (the "List" tab of the Issues screen, ISS-364/293). Filtering, sorting and
// pagination are SERVER-side through the search endpoint — the rows on screen are one page, so
// anything derived from `rows` describes the page and never the project. Live via WS on
// `['issues','search']`, the one key the event-router invalidates.

import {
  BoardRowSkeleton,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Popover,
  SortableTH,
  Table,
  TBody,
  TH,
  THead,
  TR,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SegmentOption,
  type SortingState,
} from "@/design";
import { decodeFilter, decodeNumber, usePinnedViews } from "@/features/shell";
import { formatApiError } from "@/lib/api/error";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { usePathname } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";
//
// URL-as-state (ISS-436): every filter (q / filter / priority / assignee /
// groupBy / sort / page) is DERIVED from the live query string via
// `useLocationSearch`, and the setters write back with a shallow
// `replaceState` MERGE (never a rebuild — the host's `?tab=` and any sibling
// param survive, ISS-364/331). Because derivation is reactive, an external URL
// change — a pinned-view click on this same route, back/forward — restores the
// exact view without a remount (the old hydrate-once useState went stale).
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IssueBuckets, ISSUES_PAGE_SIZE } from "../api";
import { hasLiveAgentSession } from "../waiting";
import {
  ANY_AGENT_LABEL,
  filterCount,
  groupRows,
  priorityLabel,
  statusLabel,
  statusesFromParam,
} from "../derive";
import {
  useIssues,
  usePatchIssue,
  useProjectLabels,
  useProjectMembers,
  useProjectModules,
} from "../hooks";
import {
  type GroupBy,
  ISSUE_PRIORITIES,
  type IssueFilter,
  type IssuePriority,
  type IssueRow,
  type IssueSort,
} from "../types";
import { BulkActionBar } from "./bulk-action-bar";
import { useIssueSelectionBridge } from "@/features/conversations/ui-actions/selection-bridge";
import { IssuesToolbar, type ToolbarOption } from "./issues-toolbar";
import { IssueTableRow, type RowAssignee } from "./issue-row-actions";
import type { RowActions } from "./issue-table-row";
import { useGuardedTransition } from "./use-guarded-transition";

const SEGMENTS: SegmentOption<IssueFilter>[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const VALID_FILTERS: IssueFilter[] = ["open", "closed", "all"];
const DEFAULT_FILTER: IssueFilter = "open";

function withCounts(
  options: SegmentOption<IssueFilter>[],
  buckets: IssueBuckets | undefined,
): SegmentOption<IssueFilter>[] {
  if (!buckets) return options;
  return options.map((o) => ({ ...o, count: filterCount(o.value, buckets) }));
}

const GROUP_OPTIONS: ToolbarOption[] = [
  { value: "", label: "None" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "creator", label: "Creator" },
];
const VALID_GROUP_BY: GroupBy[] = ["none", "status", "priority", "creator"];

const ISSUE_COLUMNS: ColumnDef<IssueRow, unknown>[] = [
  { id: "createdAt", header: "ID", enableSorting: true, sortDescFirst: true },
  { id: "title", header: "Title", enableSorting: false },
  { id: "status", header: "Status", enableSorting: false },
  { id: "priority", header: "Priority", enableSorting: true, sortDescFirst: true },
  { id: "assignee", header: "Assignee", enableSorting: false },
  { id: "updatedAt", header: "Updated", enableSorting: true, sortDescFirst: true },
];

/** The person an issue is assigned to, else the agent working it, named by the device its run is on. */
function assigneeOf(row: IssueRow, names: Map<string, RowAssignee>): RowAssignee | null {
  const person = row.assigneeId ? names.get(row.assigneeId) : undefined;
  if (person) return person;
  if (!hasLiveAgentSession(row.agentStatus)) return null;
  const live = row.agentSessions?.find((s) => hasLiveAgentSession(s.status));
  return { label: live?.deviceName ? `Agent · ${live.deviceName}` : "Agent", agent: true };
}

function sortToState(sort: IssueSort): SortingState {
  const [id, dir] = sort.split(":");
  return [{ id, desc: dir === "desc" }];
}

function stateToSort(state: SortingState): IssueSort {
  const first = state[0];
  if (!first) return "createdAt:desc";
  return `${first.id}:${first.desc ? "desc" : "asc"}` as IssueSort;
}

const PRIORITY_OPTIONS: ToolbarOption[] = [
  { value: "", label: "Any" },
  ...ISSUE_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) })),
];

interface IssuesListViewProps {
  scope: { projectId: string; slug: string };
  /** Open the New-issue dialog (owned by the host screen). */
  onNewIssue?: () => void;
  /** False for project viewers (read-only): row quick-action mutations
   *  (transition / priority / complexity) are hidden. Optional, defaults
   *  true so other callers keep their behaviour. */
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

  const search = useLocationSearch();
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const q = sp.get("q") ?? "";
  const rawFilter = decodeFilter<IssueFilter>(sp, "filter", DEFAULT_FILTER);
  const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : DEFAULT_FILTER;
  const rawPriority = sp.get("priority") ?? "";
  const priority = (ISSUE_PRIORITIES as string[]).includes(rawPriority)
    ? (rawPriority as IssuePriority)
    : undefined;
  const createdBy = sp.get("createdBy") ?? "";
  const assignee = sp.get("assignee") ?? "";
  const label = sp.get("label") ?? "";
  const moduleId = sp.get("module") ?? "";
  const statusParam = useMemo(() => statusesFromParam(sp.get("status")), [sp]);
  const rawGroupBy = decodeFilter<GroupBy>(sp, "groupBy", "none");
  const groupBy = VALID_GROUP_BY.includes(rawGroupBy) ? rawGroupBy : "none";
  const sort = decodeFilter<IssueSort>(sp, "sort", "createdAt:desc");
  const page = decodeNumber(sp, "page", 1);
  const sorting = useMemo(() => sortToState(sort), [sort]);

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
      notifyLocationChange();
    },
    [pathname],
  );

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

  const viewHref = useMemo(() => {
    const p = new URLSearchParams(search);
    p.delete("new");
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  }, [pathname, search]);
  const isPinned = pinnedViews.isPinned(viewHref);
  const [pinOpen, setPinOpen] = useState(false);
  const pinAnchor = useRef<HTMLDivElement>(null);
  const [pinName, setPinName] = useState("");
  const defaultPinLabel = `Issues${filter !== DEFAULT_FILTER ? ` · ${filter}` : ""}${q ? ` · "${q}"` : ""}`;

  function onPinClick() {
    if (isPinned) {
      pinnedViews.remove(viewHref);
      return;
    }
    if (pinOpen) {
      setPinOpen(false);
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
    createdBy: createdBy || undefined,
    assignee: assignee || undefined,
    label: label || undefined,
    module: moduleId || undefined,
    status: statusParam,
    sort,
    page,
    pageSize: ISSUES_PAGE_SIZE,
  });
  const membersQ = useProjectMembers(projectId);
  const labelsQ = useProjectLabels(projectId);
  const modulesQ = useProjectModules(projectId);
  const patch = usePatchIssue();
  const {
    requestTransition,
    dialog: reasonDialog,
    isPending: transitionPending,
  } = useGuardedTransition();

  // ISS-1137 — a writer is a named account, so every member is offered under
  // its own name and an agent is marked rather than replaced by a class label.
  // "any agent" stays as a KIND filter above them, which is a different
  // question from "which writer" and is why it is not one of the names.
  const { user } = useAuth();
  const creatorOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Anyone" },
      ...(user ? [{ value: user.id, label: "Me" }] : []),
      { value: "agent", label: ANY_AGENT_LABEL },
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({
          value: m.userId,
          label: m.kind === "agent" ? `${m.displayName ?? m.email} (agent)` : (m.displayName ?? m.email),
        })),
    ],
    [membersQ.data, user],
  );
  const assigneeOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Anyone" },
      ...(user ? [{ value: user.id, label: "Me" }] : []),
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({ value: m.userId, label: m.displayName ?? m.email })),
    ],
    [membersQ.data, user],
  );

  const memberNames = useMemo(
    () =>
      new Map<string, RowAssignee>(
        (membersQ.data ?? []).map((m) => [
          m.userId,
          { label: m.displayName ?? m.email, agent: m.kind === "agent" },
        ]),
      ),
    [membersQ.data],
  );

  const labelOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Any" },
      ...(labelsQ.data ?? [])
        .filter((l) => l.kind !== "module")
        .map((l) => ({ value: l.id, label: l.name })),
    ],
    [labelsQ.data],
  );
  const moduleOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Any" },
      ...modulesQ.modules.map((m) => ({ value: m.id, label: m.name })),
    ],
    [modulesQ.modules],
  );
  const activeModuleName = useMemo(
    () => modulesQ.modules.find((m) => m.id === moduleId)?.name ?? null,
    [modulesQ.modules, moduleId],
  );

  const rows = useMemo(() => issuesQ.data?.items ?? [], [issuesQ.data]);
  const now = issuesQ.dataUpdatedAt || Date.now();
  const total = issuesQ.data?.totalCount ?? 0;
  const buckets = issuesQ.data?.extra?.buckets;
  const segments = useMemo(() => withCounts(SEGMENTS, buckets), [buckets]);
  const pageCount = Math.max(1, Math.ceil(total / ISSUES_PAGE_SIZE));

  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);

  const actions: RowActions = {
    patch: patch.mutate,
    transition: ({ id, toStatus }) => requestTransition(id, toStatus),
    isPending: patch.isPending || transitionPending,
    canWrite,
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkEnabled = canWrite;
  const sortTable = useReactTable<IssueRow>({
    columns: ISSUE_COLUMNS,
    data: rows,
    manualSorting: true,
    enableSortingRemoval: true,
    getCoreRowModel: getCoreRowModel(),
    state: { sorting },
    onSortingChange: (updater) => {
      const next = stateToSort(typeof updater === "function" ? updater(sorting) : updater);
      setParams({ sort: next !== "createdAt:desc" ? next : "", page: "" });
    },
  });
  const headers = sortTable.getHeaderGroups()[0]?.headers ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on any view change, not on `selected` itself.
  useEffect(() => {
    setSelected(new Set());
  }, [q, filter, priority, createdBy, assignee, label, moduleId, sort, page]);

  const toggleRow = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedCount = useMemo(
    () => pageIds.filter((id) => selected.has(id)).length,
    [pageIds, selected],
  );
  const allOnPageSelected = pageIds.length > 0 && selectedCount === pageIds.length;
  const someOnPageSelected = selectedCount > 0 && !allOnPageSelected;
  const toggleAllOnPage = useCallback(
    (next: boolean) => setSelected(next ? new Set(pageIds) : new Set()),
    [pageIds],
  );
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  useIssueSelectionBridge(rows, selectedRows, setSelected);

  const isFiltered =
    q !== "" ||
    filter !== DEFAULT_FILTER ||
    !!priority ||
    !!createdBy ||
    !!assignee ||
    !!label ||
    !!moduleId ||
    statusParam !== undefined;
  const projectHasIssues = segments.some((o) => (o.count ?? 0) > 0);

  const clearAll = () =>
    setParams({
      q: "",
      filter: "",
      priority: "",
      createdBy: "",
      assignee: "",
      status: "",
      label: "",
      module: "",
      groupBy: "",
      page: "",
    });

  return (
    <>
      {reasonDialog}
      <IssuesToolbar
        segments={segments}
        segment={filter}
        onSegment={(v) => setParams({ filter: v !== DEFAULT_FILTER ? v : "", page: "" })}
        query={rawQ}
        onQuery={setRawQ}
        fields={[
          { param: "priority", title: "Priority", value: priority ?? "", options: PRIORITY_OPTIONS },
          { param: "createdBy", title: "Created by", value: createdBy, options: creatorOptions },
          { param: "assignee", title: "Assignee", value: assignee, options: assigneeOptions },
          { param: "label", title: "Label", value: label, options: labelOptions },
          { param: "module", title: "Module", value: moduleId, options: moduleOptions },
          { param: "groupBy", title: "Group by", value: groupBy === "none" ? "" : groupBy, options: GROUP_OPTIONS },
        ]}
        extraChips={
          statusParam
            ? [{ param: "status", value: sp.get("status") ?? "", label: `Status: ${statusParam.map(statusLabel).join(", ")}` }]
            : []
        }
        onParam={(param, value) => setParams({ [param]: value, page: "" })}
        onClear={isFiltered || groupBy !== "none" ? clearAll : undefined}
        trailing={
          <div ref={pinAnchor} className="relative">
            <Button
              variant={isPinned ? "secondary" : "ghost"}
              size="sm"
              icon="pin"
              aria-pressed={isPinned}
              aria-label={isPinned ? "Pinned view" : "Pin view"}
              onClick={onPinClick}
            >
              <span className="hidden sm:inline">{isPinned ? "Pinned" : "Pin view"}</span>
            </Button>
            <Popover
              open={pinOpen}
              anchor={pinAnchor}
              onDismiss={() => setPinOpen(false)}
              placement="bottom-end"
              gap={8}
              takesFocus
              role="dialog"
              aria-label="Pin this view"
              className="w-72 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-lg"
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
            </Popover>
          </div>
        }
      />

      {bulkEnabled && (
        <div className="px-4 sm:px-6">
          <BulkActionBar projectId={projectId} selectedRows={selectedRows} onCleared={clearSelection} />
        </div>
      )}

      {issuesQ.isLoading && (
        <div className="border-t border-line">
          {Array.from({ length: 6 }).map((_, i) => (
            <BoardRowSkeleton key={i} />
          ))}
        </div>
      )}

      {issuesQ.isError && (
        <div className="px-4 sm:px-6">
          <ErrorState
            title="Couldn't load issues"
            message={formatApiError(issuesQ.error)}
            onRetry={() => issuesQ.refetch()}
          />
        </div>
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length === 0 && (
        <div className="border-t border-line px-4 py-6 sm:px-6">
          <EmptyState
            title={
              moduleId
                ? "No issues in this module"
                : isFiltered
                  ? "Nothing here"
                  : projectHasIssues
                    ? "Nothing is waiting on you"
                    : "No issues yet"
            }
            message={
              moduleId
                ? `No issues tagged to ${activeModuleName ?? "this module"}.`
                : createdBy
                  ? `No issues created by ${
                      creatorOptions.find((o) => o.value === createdBy)?.label ??
                      "that creator"
                    }.`
                  : isFiltered
                    ? "No issues match this search or filter."
                    : projectHasIssues
                      ? "Work is moving without you — the other filters say where it is."
                      : "Issues for this project will appear here as work is filed."
            }
            mascot={!isFiltered}
            action={
              isFiltered
                ? {
                    label: "Clear filters",
                    onClick: clearAll,
                  }
                : onNewIssue
                  ? { label: "New issue", onClick: onNewIssue }
                  : undefined
            }
          />
        </div>
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length > 0 && (
        <>
          {/* cm:why one table runs edge to edge from the sidebar, scrolling sideways inside itself at phone width; a grouping is a header row in it, not a box per group (ISS-49) */}
          <Table flush aria-label="Issues" className="min-w-[860px]">
            <THead>
              <TR>
                {bulkEnabled && (
                  <TH className="w-9 pr-0">
                    <Checkbox
                      checked={allOnPageSelected}
                      indeterminate={someOnPageSelected}
                      onChange={toggleAllOnPage}
                      ariaLabel="Select all issues on this page"
                    />
                  </TH>
                )}
                {headers.map((header) => (
                  <SortableTH
                    key={header.id}
                    header={header}
                    className={header.id === "createdAt" ? "w-px whitespace-nowrap" : undefined}
                  />
                ))}
                <TH className="sr-only">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {groupBy !== "none" && (
                    <TR className="bg-sunken hover:bg-sunken">
                      <TH
                        scope="colgroup"
                        colSpan={headers.length + (bulkEnabled ? 2 : 1)}
                        className="text-left"
                      >
                        {g.label} · {g.rows.length}
                      </TH>
                    </TR>
                  )}
                  {g.rows.map((row) => (
                    <IssueTableRow
                      key={row.id}
                      row={row}
                      slug={slug}
                      actions={actions}
                      now={now}
                      assignee={assigneeOf(row, memberNames)}
                      selection={
                        bulkEnabled
                          ? {
                              selected: selected.has(row.id),
                              onToggle: (next) => toggleRow(row.id, next),
                            }
                          : undefined
                      }
                    />
                  ))}
                </Fragment>
              ))}
            </TBody>
          </Table>

          {pageCount > 1 && (
            <div className="flex justify-end px-4 py-4 sm:px-6">
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
