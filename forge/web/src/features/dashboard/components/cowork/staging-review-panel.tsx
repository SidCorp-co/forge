'use client';

import { useState } from 'react';
import { useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useCreateComment } from '@/features/comment/hooks/use-comments';
import type { Issue } from '@/features/issue/types';
import { ExternalLink, Loader2, Rocket, Plus, Minus } from 'lucide-react';

interface StagingReviewPanelProps {
  issue: Issue;
  testingUrls?: { label: string; url: string }[];
}

export function StagingReviewPanel({ issue, testingUrls }: StagingReviewPanelProps) {
  const updateIssue = useUpdateIssue();
  const createComment = useCreateComment(issue.documentId);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const isLoading = updateIssue.isPending;

  const sessions = issue.agentSessions ?? [];
  const totalAdditions = sessions.reduce((sum, s) => {
    const diff = (s as any)?.diff;
    return sum + (diff?.total_additions ?? 0);
  }, 0);
  const totalDeletions = sessions.reduce((sum, s) => {
    const diff = (s as any)?.diff;
    return sum + (diff?.total_deletions ?? 0);
  }, 0);

  const handleRelease = () => {
    updateIssue.mutate({ id: issue.documentId, data: { status: 'released' } });
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
      {testingUrls && testingUrls.length > 0 && (
        <div className="flex items-center gap-2 rounded-sm border border-outline-variant/20 bg-surface-container-low px-3 py-2">
          <Rocket className="h-4 w-4 text-info shrink-0" />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-xs text-on-surface-variant">Testing Environments</p>
            {testingUrls.map((entry, i) => (
              <a
                key={i}
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-info hover:text-info/80 truncate"
              >
                <span className="text-outline shrink-0">{entry.label}:</span>
                {entry.url}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {(totalAdditions > 0 || totalDeletions > 0) && (
        <div className="flex items-center gap-3 text-xs text-on-surface-variant">
          <span className="flex items-center gap-1 text-success"><Plus className="h-3 w-3" />{totalAdditions}</span>
          <span className="flex items-center gap-1 text-error"><Minus className="h-3 w-3" />{totalDeletions}</span>
          <span>total across {sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Reason for rejection..."
          className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none resize-none"
          rows={3}
          autoFocus
        />
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleRelease}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-tertiary disabled:opacity-50"
        >
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          Release to Production
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
