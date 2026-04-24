'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Skeleton } from '@/components/ui';
import type { Issue } from '@forge/contracts';
import { useIssuesPage } from '../hooks';

/**
 * Phase 2.6-F2: a minimal issue list view. The rich toolbar + bulk actions
 * + board toggle from the legacy Strapi page is deferred to a follow-up so
 * this file stays reviewable. The list shows displayId, title, status,
 * priority and links through to the detail page which now does its own
 * rewire against forge/core.
 */
export function IssuesView() {
  const router = useRouter();
  const { slug, issues, isLoading, total } = useIssuesPage();

  return (
    <div className="space-y-4">
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
            <li
              key={issue.id}
              onClick={() => router.push(`/projects/${slug}/issues/${issue.id}`)}
              className="flex cursor-pointer items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-surface-container-low"
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
