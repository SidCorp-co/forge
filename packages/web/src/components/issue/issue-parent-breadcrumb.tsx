'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import { useParentChain } from '@/features/issue/hooks/use-parent-chain';

interface IssueParentBreadcrumbProps {
  issueId: string;
  projectSlug: string;
  currentDisplayId: string;
}

export function IssueParentBreadcrumb({
  issueId,
  projectSlug,
  currentDisplayId,
}: IssueParentBreadcrumbProps) {
  const { data, isLoading } = useParentChain(issueId);
  if (isLoading || !data || data.chain.length === 0) return null;

  return (
    <nav
      aria-label="Parent chain"
      className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-widest text-outline"
    >
      <span>Parent:</span>
      {data.truncated && (
        <>
          <span className="text-outline-variant">…</span>
          <span className="text-outline-variant">›</span>
        </>
      )}
      {data.chain.map((ancestor) => (
        <Fragment key={ancestor.id}>
          <Link
            href={`/projects/${projectSlug}/issues/${ancestor.displayId}`}
            className="font-mono text-primary hover:underline"
            title={ancestor.title}
          >
            {ancestor.displayId}
          </Link>
          <span className="text-outline-variant">›</span>
        </Fragment>
      ))}
      <span className="font-mono text-primary">{currentDisplayId}</span>
      <span>(current)</span>
    </nav>
  );
}
