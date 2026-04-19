'use client';

import { useState } from 'react';
import { Markdown } from '@/components/ui/markdown';
import { useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useCreateComment } from '@/features/comment/hooks/use-comments';
import type { Issue } from '@/features/issue/types';
import { Loader2 } from 'lucide-react';

interface PlanReviewPanelProps {
  issue: Issue;
}

export function PlanReviewPanel({ issue }: PlanReviewPanelProps) {
  const updateIssue = useUpdateIssue();
  const createComment = useCreateComment(issue.documentId);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const isLoading = updateIssue.isPending;

  const handleApprove = () => {
    updateIssue.mutate({ id: issue.documentId, data: { status: 'approved' } });
  };

  const handleReject = async () => {
    if (!showComment) {
      setShowComment(true);
      return;
    }
    if (comment.trim()) {
      await createComment.mutateAsync({ body: comment.trim(), issue: issue.documentId });
    }
    updateIssue.mutate({ id: issue.documentId, data: { status: 'needs_info' } });
    setShowComment(false);
    setComment('');
  };

  return (
    <div className="space-y-3">
      {issue.plan ? (
        <div className="max-h-[400px] overflow-y-auto rounded-sm border border-info/20 bg-info-surface/20/50 p-3">
          <Markdown className="text-sm text-on-surface-variant">{issue.plan}</Markdown>
        </div>
      ) : (
        <p className="text-xs text-outline">No plan available for this issue.</p>
      )}

      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Explain what needs to change..."
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
          Approve Plan
        </button>
        <button
          onClick={handleReject}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-50"
        >
          {showComment ? 'Submit Changes' : 'Request Changes'}
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
