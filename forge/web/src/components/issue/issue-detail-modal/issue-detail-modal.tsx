'use client';

import { useEffect, useState } from 'react';
import { useIssue, useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useCreateComment } from '@/features/comment/hooks/use-comments';
import { useRouter, useParams } from 'next/navigation';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { agentApi } from '@/features/agent/api';
import { IssueHeader } from './issue-header';
import { IssuePlan } from './issue-plan';
import { IssueMetadata } from './issue-metadata';
import { IssueAgentSessions } from './issue-agent-sessions';
import { IssueCostSummary } from './issue-cost-summary';
import { IssueAttachments } from './issue-attachments';
import { IssueTasks } from './issue-tasks';
import { IssueTimeline } from '../issue-timeline';
import { CommentInput } from './comment-input';
import { IssueRelations } from '@/components/issue/issue-relations';
import { AgentSessionPanel } from '@/components/chat/agent-session-panel';
import { ErrorBoundary } from '@/components/error-boundary';

interface Props {
  issueId: string;
  onClose: () => void;
}

export function IssueDetailModal({ issueId, onClose }: Props) {
  const { data, isLoading, refetch } = useIssue(issueId);
  const issue = data?.data;
  const updateIssue = useUpdateIssue();
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const { desktopConnected } = useAgentStreamContext();
  const issueDocId = issue?.documentId ?? '';
  const createComment = useCreateComment(issueDocId);

  const [viewSessionId, setViewSessionId] = useState<string | null>(null);
  const [triggeringPipeline, setTriggeringPipeline] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (viewSessionId) setViewSessionId(null); else onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, viewSessionId]);

  const handleUpdate = (id: string, data: Record<string, any>) => {
    updateIssue.mutate({ id, data });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-on-primary/60 backdrop-blur-sm p-3 pt-[3vh] sm:p-4 sm:pt-[10vh]" onClick={onClose}>
      <div
        data-paste-zone
        className={`max-h-[90dvh] w-full overflow-hidden rounded-sm border border-outline-variant/30 bg-background shadow-[0_0_40px_rgba(0,0,0,0.5)] sm:max-h-[85dvh] flex ${viewSessionId ? 'max-w-6xl' : 'max-w-2xl lg:max-w-4xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`min-w-0 overflow-y-auto overflow-x-hidden ${viewSessionId ? 'hidden md:block md:w-1/2 lg:w-2/5 border-r border-outline-variant/30' : 'flex-1'}`}>
        {isLoading && (
          <div className="p-8 text-center text-sm text-primary-fixed">Loading...</div>
        )}

        {!isLoading && !issue && (
          <div className="p-8 text-center text-sm text-primary-fixed">Issue not found.</div>
        )}

        {!isLoading && issue && (
          <ErrorBoundary>
          <div className="divide-y divide-outline-variant/30 text-on-surface font-['Inter'] min-w-0">
            <IssueHeader issue={issue} onClose={onClose} onUpdate={handleUpdate} />

            {issue.plan && <IssuePlan plan={issue.plan} />}

            <IssueMetadata
              issue={issue}
              desktopConnected={desktopConnected}
              isBuildingPrompt={triggeringPipeline}
              onUpdate={handleUpdate}
              onStartSession={async () => {
                setTriggeringPipeline(true);
                try { await agentApi.triggerPipeline(issue.documentId); } finally { setTriggeringPipeline(false); }
              }}
            />

            <IssueAgentSessions
              sessions={issue.agentSessions ?? []}
              onSelect={(docId) => setViewSessionId(docId)}
              onRefresh={refetch}
            />

            <IssueCostSummary documentId={issue.documentId} />

            <IssueAttachments
              attachments={issue.attachments ?? []}
              issueDocumentId={issue.documentId}
              onUpdate={handleUpdate}
            />

            <IssueTasks tasks={issue.tasks ?? []} />

            <div className="overflow-x-hidden p-4 sm:p-6">
              <h3 className="mb-3 text-sm font-semibold text-on-surface-variant">Activity</h3>
              <CommentInput
                onAddComment={(body, attachments) =>
                  createComment.mutate({ body, issue: issue.documentId, attachments })
                }
              />
              <IssueTimeline issueDocumentId={issue.documentId} />
            </div>

            {/* Relations */}
            <div className="px-4 py-3 sm:px-6">
              <h3 className="mb-2 text-sm font-semibold text-on-surface-variant">Relations</h3>
              <IssueRelations
                relations={issue.relations ?? []}
                issueDocumentId={issue.documentId}
                projectSlug={slug}
                onUpdate={(relations) => handleUpdate(issue.documentId, { relations })}
              />
            </div>
          </div>
          </ErrorBoundary>
        )}
        </div>

        {/* Agent Session side panel inside modal */}
        {viewSessionId && (
          <div className="flex-1 min-w-0 min-h-0">
            <AgentSessionPanel
              sessionId={viewSessionId}
              projectSlug={slug}
              onClose={() => setViewSessionId(null)}
              onOpenFull={() => {
                router.push(`/projects/${slug}/agent?session=${viewSessionId}`);
                onClose();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
