'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { Button, Input, Select, Skeleton, ToastContainer } from '@/components/ui';
import { ALL_PRIORITIES } from '@/lib/constants';
import type { Issue } from '@forge/contracts';
import { useIssuesPage } from '../hooks';
import { StatusMultiSelect } from './status-multi-select';
import type { IssueStatus } from '@/features/issue/types';
import { IssueDetailModal } from '@/components/issue/issue-detail-modal/issue-detail-modal';
import { AgentQueueBadge, pickActiveSession } from '@/components/issue/agent-queue-badge';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { BulkActionBar } from '@/components/issue/bulk-action-bar';
import { InlineComplexitySelect } from '@/components/issue/inline-complexity-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { usePatchIssue, useTransitionIssue } from '@/features/issue/hooks/use-issues';
import { useUnblockedIssueIds } from '@/features/issue/hooks/use-unblock-cascade';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils/cn';

const REASON_LABELS: Record<string, string> = {
  illegal_transition: 'illegal transition',
  reopen_cap_exceeded: 'hit reopen limit',
  forbidden: 'no access',
  not_found: 'not found',
  stale: 'stale',
  no_op: 'no change',
};

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
    checked,
    setChecked,
    toggleCheck,
    handleBulkUpdate,
  } = useIssuesPage();
  const { toasts, addToast } = useToast();
  const patchIssue = usePatchIssue();
  const transitionIssue = useTransitionIssue();
  const { ids: unblockedIssueIds, blockerSeqFor } = useUnblockedIssueIds();

  function handleAssigneeChange(issueId: string, assigneeId: string | null) {
    patchIssue.mutate(
      { id: issueId, patch: { assigneeId } },
      { onSuccess: () => addToast('Assignee updated') },
    );
  }

  function handleStatusUpdate(id: string, data: { status: IssueStatus }) {
    transitionIssue.mutate(
      { id, toStatus: data.status },
      {
        onSuccess: () => addToast('Status updated'),
        onError: () => addToast('Status update failed'),
      },
    );
  }

  function handlePatchUpdate(label: string) {
    return (id: string, patch: Parameters<typeof patchIssue.mutate>[0]['patch']) => {
      patchIssue.mutate(
        { id, patch },
        {
          onSuccess: () => addToast(`${label} updated`),
          onError: () => addToast(`${label} update failed`),
        },
      );
    };
  }

  const visibleCategories = useMemo(
    () => [...new Set(issues.map((i) => i.category).filter((c): c is string => !!c))].sort(),
    [issues],
  );

  const [previewIssueId, setPreviewIssueId] = useState<string | null>(null);
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCheckedRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocalSearch(searchQuery); }, [searchQuery]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function handleSearchChange(value: string) {
    setLocalSearch(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setParam('q', value), 300);
  }

  const visibleCheckedCount = useMemo(
    () => issues.reduce((n, i) => (checked.has(i.id) ? n + 1 : n), 0),
    [issues, checked],
  );
  const allVisibleChecked =
    issues.length > 0 && visibleCheckedCount === issues.length;
  useEffect(() => {
    if (masterRef.current) {
      masterRef.current.indeterminate =
        visibleCheckedCount > 0 && visibleCheckedCount < issues.length;
    }
  }, [visibleCheckedCount, issues.length]);

  function handleMasterToggle() {
    if (allVisibleChecked) {
      setChecked(new Set());
    } else {
      setChecked(new Set(issues.map((i) => i.id)));
    }
  }

  function handleRowToggle(issueId: string) {
    const isShift = shiftKeyRef.current;
    shiftKeyRef.current = false;
    if (isShift && lastCheckedRef.current && lastCheckedRef.current !== issueId) {
      const lastId = lastCheckedRef.current;
      const ids = issues.map((i) => i.id);
      const lastIdx = ids.indexOf(lastId);
      const curIdx = ids.indexOf(issueId);
      if (lastIdx !== -1 && curIdx !== -1) {
        const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        const next = new Set(checked);
        const willCheck = !checked.has(issueId);
        for (let i = start; i <= end; i++) {
          const id = ids[i];
          if (!id) continue;
          if (willCheck) next.add(id);
          else next.delete(id);
        }
        setChecked(next);
        lastCheckedRef.current = issueId;
        return;
      }
    }
    toggleCheck(issueId);
    lastCheckedRef.current = issueId;
  }

  async function handleBulkApply(data: {
    status?: string;
    priority?: string;
    category?: string | null;
    manualHold?: boolean;
  }) {
    const result = await handleBulkUpdate(data as Partial<Issue>);
    if (!result) return;
    if ('error' in result) {
      addToast(`Bulk update failed: ${result.error}`);
      return;
    }
    const upd = result.updated.length;
    const partial = result.updated.filter((u) => u.skipReason).length;
    const skipped = result.skipped.length;
    const failed = result.failed.length;
    if (upd === 0 && skipped === 0 && failed === 0) return;
    const reasonCounts = new Map<string, number>();
    for (const s of result.skipped) {
      reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
    }
    for (const u of result.updated) {
      if (u.skipReason) {
        reasonCounts.set(u.skipReason, (reasonCounts.get(u.skipReason) ?? 0) + 1);
      }
    }
    const reasonSummary = [...reasonCounts.entries()]
      .map(([r, n]) => `${n} ${REASON_LABELS[r] ?? r.replace(/_/g, ' ')}`)
      .join(', ');
    if (upd === 0) {
      addToast(reasonSummary
        ? `No changes applied (${reasonSummary})`
        : `No changes applied (${skipped + failed} skipped)`);
    } else if (skipped + failed + partial > 0) {
      const detail = reasonSummary || `${skipped + failed + partial} skipped`;
      addToast(`${upd} updated — ${detail}`);
    } else {
      addToast(`${upd} issue${upd === 1 ? '' : 's'} updated`);
    }
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
        <div className="overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
          <div className="flex items-center gap-2 border-b border-outline-variant/20 px-3 py-2">
            <input
              ref={masterRef}
              type="checkbox"
              checked={allVisibleChecked}
              onChange={handleMasterToggle}
              aria-label="Select all visible issues"
              className="h-3.5 w-3.5 cursor-pointer accent-primary"
            />
            <span className="text-[10px] uppercase tracking-widest text-outline">
              {checked.size > 0
                ? `${checked.size} selected`
                : `Select all (${issues.length})`}
            </span>
          </div>
          <ul className="divide-y divide-outline-variant/20">
          {issues.map((issue: Issue) => {
            const isUnblocked = unblockedIssueIds.has(issue.id);
            const blockerSeq = isUnblocked ? blockerSeqFor(issue.id) : null;
            const unblockedTitle = isUnblocked
              ? blockerSeq != null
                ? `Unblocked by ISS-${blockerSeq}`
                : 'Unblocked'
              : undefined;
            return (
            <li
              key={issue.id}
              className={cn('flex items-center pr-2', isUnblocked && 'animate-amber-pulse')}
              title={unblockedTitle}
            >
              <input
                type="checkbox"
                checked={checked.has(issue.id)}
                onMouseDown={(e) => { shiftKeyRef.current = e.shiftKey; }}
                onChange={() => handleRowToggle(issue.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${issue.displayId}`}
                className="ml-3 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
              />
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
                className="flex min-w-0 flex-1 items-center gap-4 px-2 py-3 text-sm transition-colors hover:bg-surface-container-low"
              >
                <span className="w-20 shrink-0 font-mono text-[11px] text-primary">
                  {issue.displayId}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-on-surface">
                    {issue.title}
                  </span>
                  <AgentQueueBadge
                    session={pickActiveSession(issue.agentSessions)}
                    agentStatus={issue.agentStatus}
                    className="mt-0.5"
                  />
                </span>
              </Link>
              {issue.manualHold && (
                <span
                  className="ml-2 shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-400"
                  title="Manual hold — automation paused"
                >
                  Paused
                </span>
              )}
              <span className="ml-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                <InlineComplexitySelect issue={issue} onUpdate={handlePatchUpdate('Complexity')} />
              </span>
              {issue.category && (
                <span className="ml-2 shrink-0 text-[10px] uppercase tracking-widest text-outline">
                  {issue.category}
                </span>
              )}
              <span className="ml-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                <InlineStatusSelect issue={issue} onUpdate={handleStatusUpdate} />
              </span>
              <span className="ml-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                <InlinePrioritySelect issue={issue} onUpdate={handlePatchUpdate('Priority')} />
              </span>
              <span className="ml-2 shrink-0">
                <AssigneePicker
                  compact
                  value={issue.assigneeId ?? null}
                  members={members}
                  onChange={(id) => handleAssigneeChange(issue.id, id)}
                />
              </span>
            </li>
            );
          })}
          </ul>
        </div>
      )}
      {checked.size > 0 && (
        <BulkActionBar
          count={checked.size}
          onApply={(data) => { void handleBulkApply(data); }}
          onClear={() => setChecked((prev) => (prev.size ? new Set() : prev))}
        />
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
