'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Skeleton } from '@/components/ui';
import { ALL_PRIORITIES } from '@/lib/constants';
import type { Issue } from '@forge/contracts';
import { useIssuesPage } from '../hooks';
import { StatusMultiSelect } from './status-multi-select';
import type { IssueStatus } from '@/features/issue/types';

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
    searchQuery,
    setParam,
  } = useIssuesPage();

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
            <li key={issue.id}>
              <Link
                href={`/projects/${slug}/issues/${issue.displayId}`}
                className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-surface-container-low"
              >
                <span className="w-20 font-mono text-[11px] text-primary">
                  {issue.displayId}
                </span>
                <span className="flex-1 truncate font-medium text-on-surface">
                  {issue.title}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  {issue.status}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  {issue.priority}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
