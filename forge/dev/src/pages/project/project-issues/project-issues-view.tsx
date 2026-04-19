import { EmptyState, Skeleton } from "@/components/ui";
import { IssueDetail } from "@/components/issue-detail";
import { BulkActionBar } from "@/components/issue/bulk-action-bar";
import { useProjectIssues } from "./hooks";
import { IssuesToolbar } from "./issues-toolbar";
import { IssuesTable } from "./issues-table";
import { IssuesPagination } from "./issues-pagination";

export function ProjectIssues() {
  const {
    slug,
    issues,
    isLoading,
    refetch,
    selected,
    setSelected,
    checked,
    setChecked,
    toggleCheck,
    handleUpdate,
    handleBulkUpdate,
    handleStartSession,
    enrichMutation,
    statusFilter,
    priorityFilter,
    categoryFilter,
    sortBy,
    searchQuery,
    categories,
    handleSearchChange,
    handleStatusFilterChange,
    handlePriorityFilterChange,
    handleCategoryFilterChange,
    handleSortChange,
    filtered,
    paginatedIssues,
    currentPage,
    totalPages,
    setPage,
    ALL_STATUSES,
    ALL_PRIORITIES,
  } = useProjectIssues();

  if (isLoading) {
    return (
      <div className="p-8">
        <Skeleton className="mb-3 h-10 w-full rounded-lg" />
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-32 rounded-lg" />)}
          </div>
          <Skeleton className="h-9 w-28 rounded-lg" />
        </div>
        <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
          <Skeleton className="h-8 w-full rounded" />
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full rounded" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <IssuesToolbar
        slug={slug}
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        priorityFilter={priorityFilter}
        categoryFilter={categoryFilter}
        sortBy={sortBy}
        categories={categories}
        checkedCount={checked.size}
        allStatuses={ALL_STATUSES}
        allPriorities={ALL_PRIORITIES}
        onSearchChange={handleSearchChange}
        onStatusChange={handleStatusFilterChange}
        onPriorityChange={handlePriorityFilterChange}
        onCategoryChange={handleCategoryFilterChange}
        onSortChange={handleSortChange}
        onStartSession={handleStartSession}
      />

      {filtered.length === 0 ? (
        <EmptyState title={!issues?.length ? "No issues yet." : "No issues match your filters."} />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white">
          <IssuesTable
            issues={paginatedIssues}
            checked={checked}
            onRowClick={setSelected}
            onToggleCheck={toggleCheck}
            onToggleAll={() => {
              const allChecked = paginatedIssues.every((i) => checked.has(i.documentId));
              setChecked(allChecked ? new Set() : new Set(paginatedIssues.map((i) => i.documentId)));
            }}
            onUpdate={handleUpdate}
            onEnrich={(docId) => enrichMutation.mutate(docId)}
          />
          <IssuesPagination
            totalCount={filtered.length}
            currentPage={currentPage}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        </div>
      )}

      {checked.size > 0 && (
        <BulkActionBar
          count={checked.size}
          onApply={handleBulkUpdate}
          onClear={() => setChecked(new Set())}
        />
      )}

      {selected && (
        <IssueDetail
          issue={selected}
          onClose={() => setSelected(null)}
          onUpdated={() => {
            setSelected(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
