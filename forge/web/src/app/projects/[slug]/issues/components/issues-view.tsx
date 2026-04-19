'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Skeleton } from '@/components/ui';
import { BulkActionBar } from '@/components/issue/bulk-action-bar';
import { IssueDetailModal } from '@/components/issue/issue-detail-modal';
import { useIssuesPage } from '../hooks';
import { agentApi } from '@/features/agent/api';
import { IssuesToolbar } from './issues-toolbar';
import { IssuesTable } from './issues-table';
import { IssuesBoardView } from './issues-board-view';

export function IssuesView() {
  const router = useRouter();
  const [previewIssueId, setPreviewIssueId] = useState<string | null>(null);
  const {
    slug,
    issues,
    isLoading,
    viewMode,
    setViewMode,
    statusFilter,
    priorityFilter,
    categoryFilter,
    sortBy,
    searchQuery,
    categories,
    activeFilterCount,
    filtersOpen,
    setFiltersOpen,
    setParam,
    checked,
    setChecked,
    toggleCheck,
    filtered,
    paginated,
    pageCount,
    safePage,
    total,
    handleUpdate,
    handleBulkUpdate,
    handleStartSession,
    desktopConnected,
    isBuildingPrompt,
  } = useIssuesPage();

  function handleViewChange(v: string) {
    if (v === 'table' || v === 'board') setViewMode(v);
  }

  function navigateToIssue(docId: string) {
    router.push(`/projects/${slug}/issues/${docId}`);
  }

  async function handleStartSingle(docId: string) {
    await agentApi.triggerPipeline(docId);
  }

  function handleSelectAll() {
    const allChecked = paginated.every((i) => checked.has(i.documentId));
    setChecked(allChecked ? new Set() : new Set(paginated.map((i) => i.documentId)));
  }

  return (
    <div>
      <IssuesToolbar
        slug={slug}
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        priorityFilter={priorityFilter}
        categoryFilter={categoryFilter}
        categories={categories}
        sortBy={sortBy}
        viewMode={viewMode}
        setParam={(key, value) => {
          if (key === 'view') { handleViewChange(value); return; }
          setParam(key, value);
        }}
        activeFilterCount={activeFilterCount}
        filtersOpen={filtersOpen}
        checkedCount={checked.size}
        desktopConnected={desktopConnected}
        isBuildingPrompt={isBuildingPrompt}
        onToggleFilters={() => setFiltersOpen((p) => !p)}
        onStartSession={() => handleStartSession()}
      />

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-sm border border-outline-variant/20 bg-surface p-12 text-center">
          <p className="text-sm text-outline">
            {issues.length === 0
              ? 'No issues yet. Create your first issue to get started.'
              : 'No issues match your filters.'}
          </p>
          {issues.length === 0 && (
            <Link href={`/projects/${slug}/issues/new`} className="mt-3 inline-block">
              <Button>Create Issue</Button>
            </Link>
          )}
        </div>
      ) : viewMode === 'table' ? (
        <IssuesTable
          paginated={paginated}
          total={total}
          checked={checked}
          pageCount={pageCount}
          safePage={safePage}
          slug={slug}
          desktopConnected={desktopConnected}
          isBuildingPrompt={isBuildingPrompt}
          onToggleCheck={toggleCheck}
          onSelectAll={handleSelectAll}
          onSelectIssue={navigateToIssue}
          onPreviewIssue={setPreviewIssueId}
          onUpdate={handleUpdate}
          onStartSingle={handleStartSingle}
          setParam={setParam}
        />
      ) : (
        <IssuesBoardView
          filtered={issues}
          onUpdate={handleUpdate}
          onSelect={navigateToIssue}
        />
      )}

      {checked.size > 0 && (
        <BulkActionBar
          count={checked.size}
          onApply={handleBulkUpdate}
          onClear={() => setChecked(new Set())}
        />
      )}

      {previewIssueId && (
        <IssueDetailModal issueId={previewIssueId} onClose={() => setPreviewIssueId(null)} />
      )}
    </div>
  );
}
