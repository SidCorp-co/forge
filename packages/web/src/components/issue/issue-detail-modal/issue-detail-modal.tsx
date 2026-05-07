'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Modal, Markdown, Skeleton, Button } from '@/components/ui';
import { useIssue } from '@/features/issue/hooks/use-issues';
import { formatApiError } from '@/lib/api/error';

interface IssueDetailModalProps {
  open: boolean;
  issueId: string | null;
  projectSlug: string;
  onClose: () => void;
}

/**
 * A1.6 quick-preview. Loads only the issue row (no comments, no activity)
 * and renders description + key metadata. Esc + click-outside close — both
 * handled by `<Modal>`. The "Open full" link navigates to the dedicated
 * detail page where comments and pipeline actions live.
 */
export function IssueDetailModal({ open, issueId, projectSlug, onClose }: IssueDetailModalProps) {
  const { data: issue, isLoading, error } = useIssue(open && issueId ? issueId : undefined);

  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 py-4 sm:px-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(error)}
          </p>
        ) : !issue ? (
          <p className="text-[11px] text-outline">Issue not found.</p>
        ) : (
          <>
            <header className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 font-mono text-[11px] tracking-widest text-primary">
                  {issue.displayId}
                </div>
                <h2 className="text-base font-bold tracking-tight text-on-surface">
                  {issue.title}
                </h2>
              </div>
              <span className="shrink-0 rounded-sm border border-outline-variant/30 bg-surface-container-high px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                {issue.status}
              </span>
            </header>

            <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              <Cell label="Priority" value={issue.priority} />
              <Cell label="Category" value={issue.category ?? '—'} />
              <Cell label="Complexity" value={issue.complexity ?? '—'} />
              <Cell
                label="Assignee"
                value={issue.assigneeId ? issue.assigneeId.slice(0, 8) : '—'}
              />
            </dl>

            <section className="mb-4 max-h-[55vh] overflow-y-auto rounded-sm border border-outline-variant/20 bg-surface-container-low p-4 text-sm">
              {issue.description ? (
                <Markdown>{issue.description}</Markdown>
              ) : (
                <span className="text-outline">No description provided.</span>
              )}
            </section>

            <footer className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose} size="xs">
                Close
              </Button>
              <Link
                href={`/projects/${projectSlug}/issues/${issue.displayId}`}
                onClick={onClose}
              >
                <Button size="xs">
                  <ExternalLink className="h-3 w-3" /> Open full
                </Button>
              </Link>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] font-bold uppercase tracking-widest text-outline">{label}</dt>
      <dd className="font-mono text-on-surface">{value}</dd>
    </div>
  );
}
