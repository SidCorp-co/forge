'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Issue } from '@/features/issue/types';
import { getTimeInStatus } from '../hooks/use-attention-queue';
import { StatusBadge } from '@/components/ui/status-badge';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { PlanReviewPanel } from './cowork/plan-review-panel';
import { CodeReviewPanel } from './cowork/code-review-panel';
import { StagingReviewPanel } from './cowork/staging-review-panel';

interface AttentionCardProps {
  issue: Issue;
  slug: string;
  testingUrls?: { label: string; url: string }[];
}

function formatTimeAgo(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function AttentionCard({ issue, slug, testingUrls }: AttentionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const timeInStatus = getTimeInStatus(issue);

  return (
    <div className="border border-outline-variant/20 rounded-sm bg-surface-container-low overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-container-high transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Link
          href={`/projects/${slug}/issues/${issue.documentId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] font-mono text-outline-variant tabular-nums shrink-0 hover:text-info transition-colors"
        >
          ISS-{issue.id}
        </Link>
        <Link
          href={`/projects/${slug}/issues/${issue.documentId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-sm text-on-surface truncate min-w-0 hover:text-primary transition-colors"
        >
          {issue.title}
        </Link>
        <span className="text-[10px] font-mono text-outline shrink-0 tabular-nums">{formatTimeAgo(timeInStatus)}</span>
        <StatusBadge status={issue.status} />
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-outline shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-outline shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="border-t border-outline-variant/20 px-3 py-3">
          {issue.status === 'waiting' && <PlanReviewPanel issue={issue} />}
          {issue.status === 'developed' && <CodeReviewPanel issue={issue} />}
          {issue.status === 'staging' && <StagingReviewPanel issue={issue} testingUrls={testingUrls} />}
        </div>
      )}
    </div>
  );
}
