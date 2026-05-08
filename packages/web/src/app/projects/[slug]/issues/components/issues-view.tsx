'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { Button, Input, Select, Skeleton, ToastContainer } from '@/components/ui';
import { ALL_PRIORITIES, COMPLEXITY_COLORS } from '@/lib/constants';
import type { Issue } from '@forge/contracts';
import type { IssueComplexity } from '@/features/issue/types';
import { useIssuesPage } from '../hooks';
import { StatusMultiSelect } from './status-multi-select';
import type { IssueStatus } from '@/features/issue/types';
import { IssueDetailModal } from '@/components/issue/issue-detail-modal/issue-detail-modal';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { usePatchIssue } from '@/features/issue/hooks/use-issues';
import { useToast } from '@/hooks/use-toast';

/**
 * Phase 3.1 (ISS-248): adds a search box + status/priority filter
 * dropdowns above the list. URL/localStorage persistence is handled
 * inside useIssuesPage so reload + back/forward + cross-session restore
 * work without extra bookkeeping here. The bulk action bar + board
 * toggle from the legacy Strapi page is still deferred.
 */
export function IssuesView() {
  const {
    slug,
    issues,
    isLoading,
    total,
    statusFilter,
    priorityFilter,
    categoryFilter,
    assigneeFilter,
    members,
    sortBy,
    searchQuery,
    setParam,
  } = useIssuesPage();
  const { toasts, addToast } = useToast();
  const patchIssue = usePatchIssue();

  function handleAssigneeChange(issueId: string, assigneeId: string | null) {
    patchIssue.mutate(
      { id: issueId, patch: { assigneeId } },
      { onSuccess: () => addToast('Assignee updated') },
    );
  }

  const visibleCategories = useMemo(
    () => [...new Set(issues.map((i) => i.category).filter((c): c is string => !!c))].sort(),
    [issues],
  );

  const [previewIssueId, setPreviewIssueId] = useState<string | null>(null);
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setLocalSearch(searchQuery); }, [searchQuery]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function handleSearchChange(value: string) {
    setLocalSearch(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setParam('q', value), 300);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          type="text"
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search issues…"
          aria-label="Search issues"
          className="min-w-[200px] flex-1"
        />
        <StatusMultiSelect
          selected={statusFilter as IssueStatus[]}
          onChange={(statuses) => setParam('status', statuses.join(','))}
        />
        <Select
          value={priorityFilter}
          onChange={(e) => setParam('priority', e.currentTarget.value)}
          aria-label="Filter by priority"
        >
          <option value="all">All priorities</option>
          {ALL_PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </Select>
        {visibleCategories.length > 0 && (
          <Select
            value={categoryFilter}
            onChange={(e) => setParam('category', e.currentTarget.value)}
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {visibleCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        )}
        <Select
          value={assigneeFilter}
          onChange={(e) => setParam('assignee', e.currentTarget.value)}
          aria-label="Filter by assignee"
        >
          <option value="all">All assignees</option>
          <option value="unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>{m.email}</option>
          ))}
        </Select>
        <Select
          value={sortBy}
          onChange={(e) => setParam('sort', e.currentTarget.value)}
          aria-label="Sort issues"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-outline">
          {total} issue{total === 1 ? '' : 's'}
        </div>
        <Link href={`/projects/${slug}/issues/new`}>
          <Button>New issue</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : issues.length === 0 ? (
        <div className="rounded-sm border border-outline-variant/20 bg-surface p-12 text-center">
          <p className="text-sm text-outline">No issues yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/20 overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
          {issues.map((issue: Issue) => (
            <li key={issue.id} className="flex items-center pr-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setPreviewIssueId(issue.id);
                }}
                className="ml-2 mr-1 shrink-0 rounded-sm p-1.5 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface"
                aria-label={`Quick preview ${issue.displayId}`}
                title="Quick preview"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
              <Link
                href={`/projects/${slug}/issues/${issue.displayId}`}
                className="flex flex-1 items-center gap-4 px-2 py-3 text-sm transition-colors hover:bg-surface-container-low"
              >
                <span className="w-20 font-mono text-[11px] text-primary">
                  {issue.displayId}
                </span>
                <span className="flex-1 truncate font-medium text-on-surface">
                  {issue.title}
                </span>
                {issue.manualHold && (
                  <span
                    className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-400"
                    title="Manual hold — automation paused"
                  >
                    Paused
                  </span>
                )}
                {issue.complexity && (
                  <span
                    className={`rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${COMPLEXITY_COLORS[issue.complexity as IssueComplexity]}`}
                  >
                    {issue.complexity}
                  </span>
                )}
                {issue.category && (
                  <span className="text-[10px] uppercase tracking-widest text-outline">
                    {issue.category}
                  </span>
                )}
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  {issue.status}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  {issue.priority}
                </span>
              </Link>
              <span className="ml-2 shrink-0">
                <AssigneePicker
                  compact
                  value={issue.assigneeId ?? null}
                  members={members}
                  onChange={(id) => handleAssigneeChange(issue.id, id)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <IssueDetailModal
        open={!!previewIssueId}
        issueId={previewIssueId}
        projectSlug={slug}
        onClose={() => setPreviewIssueId(null)}
      />
      <ToastContainer toasts={toasts} />
    </div>
  );
}
