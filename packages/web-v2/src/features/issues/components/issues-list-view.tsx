"use client";

// Issues List view (the "List" tab of the Issues screen, ISS-364/293). Filtering, sorting and
// pagination are SERVER-side through the search endpoint — the rows on screen are one page, so
// anything derived from `rows` describes the page and never the project. Live via WS on
// `['issues','search']`, the one key the event-router invalidates.

import { BoardRowSkeleton, ErrorState, Pagination, type SegmentOption } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useMemo } from "react";
import { type IssueBuckets, ISSUES_PAGE_SIZE } from "../api";
import { filterCount } from "../derive";
import { useIssues, usePatchIssue } from "../hooks";
import { ISSUE_PRIORITIES, type IssueFilter } from "../types";
import { BulkActionBar } from "./bulk-action-bar";
import { IssuesToolbar, type ToolbarOption } from "./issues-toolbar";
import type { RowActions } from "./issue-table-row";
import { IssuesEmptyState } from "./list/issues-empty-state";
import { IssuesTable } from "./list/issues-table";
import { PinViewButton } from "./list/pin-view-button";
import { useIssueFilterOptions } from "./list/use-filter-options";
import { DEFAULT_FILTER, useIssueListParams } from "./list/use-list-params";
import { usePageSelection } from "./list/use-page-selection";
import { useGuardedTransition } from "./use-guarded-transition";

const segmentsOf = (t: Copy): SegmentOption<IssueFilter>[] => [
  { value: "open", label: t("issues.segment.open") },
  { value: "closed", label: t("issues.segment.closed") },
  { value: "all", label: t("issues.segment.all") },
];

function withCounts(
  options: SegmentOption<IssueFilter>[],
  buckets: IssueBuckets | undefined,
): SegmentOption<IssueFilter>[] {
  if (!buckets) return options;
  return options.map((o) => ({ ...o, count: filterCount(o.value, buckets) }));
}

const groupOptionsOf = (t: Copy): ToolbarOption[] => [
  { value: "", label: t("issues.group.none") },
  { value: "status", label: t("issues.field.status") },
  { value: "priority", label: t("issues.field.priority") },
  { value: "creator", label: t("issues.field.creator") },
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
  const view = useIssueListParams(slug);
  const { q, filter, priority, createdBy, assignee, label, moduleId, statusParam, groupBy, sort, page, setParams } =
    view;
  const t = useCopy();
  const L = useLabel();
  const defaultPinLabel = `${t("issues.screen.title")}${filter !== DEFAULT_FILTER ? ` · ${filter}` : ""}${q ? ` · "${q}"` : ""}`;
  const priorityOptions: ToolbarOption[] = [{ value: "", label: t("issues.filter.any") }, ...ISSUE_PRIORITIES.map((p) => ({ value: p, label: L("issuePriority", p) }))];

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
  const options = useIssueFilterOptions(projectId, moduleId);
  const patch = usePatchIssue();
  const {
    requestTransition,
    dialog: reasonDialog,
    isPending: transitionPending,
  } = useGuardedTransition();

  const rows = useMemo(() => issuesQ.data?.items ?? [], [issuesQ.data]);
  const now = issuesQ.dataUpdatedAt || Date.now();
  const total = issuesQ.data?.totalCount ?? 0;
  const buckets = issuesQ.data?.extra?.buckets;
  const segments = useMemo(() => withCounts(segmentsOf(t), buckets), [buckets, t]);
  const pageCount = Math.max(1, Math.ceil(total / ISSUES_PAGE_SIZE));

  const actions: RowActions = {
    patch: patch.mutate,
    transition: ({ id, toStatus }) => requestTransition(id, toStatus),
    isPending: patch.isPending || transitionPending,
    canWrite,
  };

  const bulkEnabled = canWrite;
  const selection = usePageSelection(
    rows,
    JSON.stringify([q, filter, priority, createdBy, assignee, label, moduleId, sort, page]),
  );

  const projectHasIssues = segments.some((o) => (o.count ?? 0) > 0);

  return (
    <>
      {reasonDialog}
      <IssuesToolbar
        segments={segments}
        segment={filter}
        onSegment={(v) => setParams({ filter: v !== DEFAULT_FILTER ? v : "", page: "" })}
        query={view.rawQ}
        onQuery={view.setRawQ}
        fields={[
          { param: "priority", title: t("issues.field.priority"), value: priority ?? "", options: priorityOptions },
          { param: "createdBy", title: t("issues.field.createdBy"), value: createdBy, options: options.creatorOptions },
          { param: "assignee", title: t("issues.field.assignee"), value: assignee, options: options.assigneeOptions },
          { param: "label", title: t("issues.field.label"), value: label, options: options.labelOptions },
          { param: "module", title: t("issues.field.module"), value: moduleId, options: options.moduleOptions },
          { param: "groupBy", title: t("common.groupBy"), value: groupBy === "none" ? "" : groupBy, options: groupOptionsOf(t) },
        ]}
        extraChips={
          statusParam
            ? [{ param: "status", value: view.rawStatus ?? "", label: `${t("issues.field.status")}: ${statusParam.map((s) => L("issueStatus", s)).join(", ")}` }]
            : []
        }
        onParam={(param, value) => setParams({ [param]: value, page: "" })}
        onClear={view.isFiltered || groupBy !== "none" ? view.clearAll : undefined}
        trailing={<PinViewButton pathname={view.pathname} search={view.search} defaultLabel={defaultPinLabel} />}
      />

      {bulkEnabled && (
        <div className="px-4 sm:px-6">
          <BulkActionBar projectId={projectId} selectedRows={selection.selectedRows} onCleared={selection.clearSelection} />
        </div>
      )}

      {issuesQ.isLoading && (
        <div className="border-t border-line">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length placeholder list that never reorders
            <BoardRowSkeleton key={i} />
          ))}
        </div>
      )}

      {issuesQ.isError && (
        <div className="px-4 sm:px-6">
          <ErrorState
            title={t("issues.list.loadFailed")}
            message={formatApiError(issuesQ.error)}
            onRetry={() => issuesQ.refetch()}
          />
        </div>
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length === 0 && (
        <IssuesEmptyState
          inModule={!!moduleId}
          moduleName={options.activeModuleName}
          creatorName={
            createdBy
              ? (options.creatorOptions.find((o) => o.value === createdBy)?.label ?? t("issues.empty.thatCreator"))
              : null
          }
          isFiltered={view.isFiltered}
          projectHasIssues={projectHasIssues}
          onClear={view.clearAll}
          onNewIssue={onNewIssue}
        />
      )}

      {!issuesQ.isLoading && !issuesQ.isError && rows.length > 0 && (
        <>
          <IssuesTable
            rows={rows}
            groupBy={groupBy}
            sort={sort}
            onSort={(next) => setParams({ sort: next !== "createdAt:desc" ? next : "", page: "" })}
            slug={slug}
            actions={actions}
            now={now}
            memberNames={options.memberNames}
            selection={bulkEnabled ? selection : undefined}
          />

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
