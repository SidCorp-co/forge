'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useIssue, useTransitionIssue } from '@/features/issue/hooks/use-issues';
import { formatApiError } from '@/lib/api/error';

/**
 * Phase 2.6-F2: minimum viable issue detail. Renders the core fields that
 * `/api/issues/:id` actually returns (title, displayId, status, priority,
 * category, description, labels) plus a transition action. Rich features
 * (comments, attachments, agent sessions, relations, AI analysis,
 * complexity, reportedBy, manualHold, changeHistory, plan markdown) land in
 * a follow-up — most of them have no core-backed data yet.
 */
export default function IssueDetailPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const { data: issue, isLoading, error } = useIssue(id);
  const transitionIssue = useTransitionIssue();

  if (isLoading) {
    return (
      <div className="p-8 text-center text-xs font-mono text-outline-variant">
        LOADING ISSUE_DATA…
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="p-8 text-center bg-surface text-on-surface">
        <p className="mb-2 text-[10px] uppercase tracking-widest text-danger font-bold">
          {error ? formatApiError(error) : 'Issue not found'}
        </p>
        <Link
          href={`/projects/${slug}/issues`}
          className="text-xs uppercase hover:underline text-on-surface-variant"
        >
          ← Back to issues
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 space-y-6">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-outline">
        <Link
          href={`/projects/${slug}/issues`}
          className="transition-colors hover:text-on-surface"
        >
          Issues
        </Link>
        <span className="text-outline-variant">/</span>
        <span className="font-mono text-primary tracking-widest">{issue.displayId}</span>
      </div>

      <h1 className="text-2xl font-bold text-primary">{issue.title}</h1>

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
          {issue.status}
        </span>
        <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
          {issue.priority}
        </span>
        {issue.category && (
          <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
            {issue.category}
          </span>
        )}
      </div>

      {issue.labels && issue.labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-outline-variant">
            Labels
          </span>
          {issue.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[10px] font-medium"
              style={l.color ? { borderColor: l.color, color: l.color } : undefined}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Description
          </h3>
        </div>
        <div className="whitespace-pre-wrap p-5 text-sm text-on-surface">
          {issue.description || (
            <span className="text-outline">No description provided</span>
          )}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            transitionIssue.mutate({ id: issue.id, toStatus: 'closed' })
          }
          disabled={transitionIssue.isPending}
          className="rounded-sm border border-outline-variant/30 bg-surface-container-high px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest hover:bg-surface-container-highest disabled:opacity-50"
        >
          Close issue
        </button>
      </div>

      <UnimplementedBanner
        feature="Issue detail — rich view"
        hint="Comments, activity log, attachments, agent sessions, and relations will return once their core endpoints populate real data (currently empty arrays)."
      />
    </div>
  );
}
