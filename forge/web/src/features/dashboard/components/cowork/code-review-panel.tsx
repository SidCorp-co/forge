'use client';

import { useState } from 'react';
import { useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useCreateComment } from '@/features/comment/hooks/use-comments';
import type { Issue } from '@/features/issue/types';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { FileCode, Plus, Minus, ExternalLink, Loader2 } from 'lucide-react';

interface CodeReviewPanelProps {
  issue: Issue;
}

export function CodeReviewPanel({ issue }: CodeReviewPanelProps) {
  const { slug } = useParams<{ slug: string }>();
  const updateIssue = useUpdateIssue();
  const createComment = useCreateComment(issue.documentId);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const isLoading = updateIssue.isPending;

  const sessions = issue.agentSessions ?? [];
  const latestSession = sessions.length > 0
    ? sessions.reduce((a, b) => new Date(a.createdAt) > new Date(b.createdAt) ? a : b)
    : null;

  const diff = (latestSession as any)?.diff as { files: { path: string; additions: number; deletions: number }[]; total_additions: number; total_deletions: number } | null | undefined;

  const handleApprove = () => {
    updateIssue.mutate({ id: issue.documentId, data: { status: 'deploying' } });
  };

  const handleReject = async () => {
    if (!showComment) {
      setShowComment(true);
      return;
    }
    if (comment.trim()) {
      await createComment.mutateAsync({ body: comment.trim(), issue: issue.documentId });
    }
    updateIssue.mutate({ id: issue.documentId, data: { status: 'reopen' } });
    setShowComment(false);
    setComment('');
  };

  return (
    <div className="space-y-3">
      {diff && diff.files?.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs text-on-surface-variant mb-2">
            <span className="flex items-center gap-1 text-success"><Plus className="h-3 w-3" />{diff.total_additions}</span>
            <span className="flex items-center gap-1 text-error"><Minus className="h-3 w-3" />{diff.total_deletions}</span>
            <span>{diff.files.length} file{diff.files.length !== 1 ? 's' : ''} changed</span>
          </div>
          <div className="max-h-[250px] overflow-y-auto rounded-sm border border-outline-variant/20 bg-surface-container-low">
            {diff.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-outline-variant/10 last:border-0">
                <FileCode className="h-3.5 w-3.5 text-outline shrink-0" />
                <span className="text-on-surface-variant truncate flex-1 font-mono">{f.path}</span>
                <span className={cn('shrink-0 tabular-nums', f.additions > 0 ? 'text-success' : 'text-outline')}>+{f.additions}</span>
                <span className={cn('shrink-0 tabular-nums', f.deletions > 0 ? 'text-error' : 'text-outline')}>-{f.deletions}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-outline">No diff data available for this issue.</p>
      )}

      {latestSession && (
        <Link
          href={`/projects/${slug}/agent?session=${latestSession.documentId}`}
          className="inline-flex items-center gap-1.5 text-xs text-info hover:text-info/80 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          View Full Session
        </Link>
      )}

      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Explain what needs to be fixed..."
          className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none resize-none"
          rows={3}
          autoFocus
        />
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleApprove}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-tertiary disabled:opacity-50"
        >
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          Approve & Deploy
        </button>
        <button
          onClick={handleReject}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-50"
        >
          {showComment ? 'Submit Rejection' : 'Reject'}
        </button>
        {showComment && (
          <button
            onClick={() => { setShowComment(false); setComment(''); }}
            className="text-xs text-outline hover:text-on-surface-variant"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
