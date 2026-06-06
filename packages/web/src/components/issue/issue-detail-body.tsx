'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Markdown } from '@/components/ui/markdown';
import { Button } from '@/components/ui';
import { issueKeys } from '@/features/issue/hooks/use-issues';
import { IssueTimeline } from '@/components/issue/issue-timeline';
import { apiClient } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { IssuePipelineRunPanel } from '@/components/issue/issue-detail-modal/issue-pipeline-run-panel';
import { IssueAgentSessions } from '@/components/issue/issue-detail-modal/issue-agent-sessions';
import { IssueAttachments } from '@/components/issue/issue-detail-modal/issue-attachments';
import { IssueJobs } from '@/components/issue/issue-detail-modal/issue-jobs';
import { IssueTasks } from '@/components/issue/issue-detail-modal/issue-tasks';
import { IssueCostSummary } from '@/components/issue/issue-detail-modal/issue-cost-summary';
import { IssuePipelineTiming } from '@/components/issue/issue-pipeline-timing';
import { IssueDecompositionPanel } from '@/components/issue/issue-decomposition-panel';
import { IssueDetailTabs, type IssueDetailTabKey } from '@/components/issue/issue-detail-tabs';
import { IssueDetailHeader } from '@/components/issue/issue-detail-header';
import { MetadataCard } from '@/components/issue/aside/metadata-card';
import { PipelineCard } from '@/components/issue/aside/pipeline-card';
import { LinkedCard } from '@/components/issue/aside/linked-card';
import { BranchConfigCard } from '@/components/issue/aside/branch-config-card';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';
import type { ProjectMemberRow } from '@/features/project/hooks/use-project-members';
import type { MeProfile } from '@/features/me/types';

interface CoreComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CoreCommentNode extends CoreComment {
  replies?: CoreCommentNode[];
}

const commentsKey = (issueId: string | undefined) =>
  ['issue', issueId, 'comments'] as const;

function flattenCommentTree(nodes: CoreCommentNode[]): CoreComment[] {
  const out: CoreComment[] = [];
  const walk = (node: CoreCommentNode) => {
    const { replies: _replies, ...row } = node;
    out.push(row);
    for (const child of node.replies ?? []) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
}

export interface IssueDetailBodyProps {
  issue: Issue;
  projectSlug: string;
  members: ProjectMemberRow[];
  meProfile: MeProfile | null;
  isProjectOwner: boolean;
  activeTab: IssueDetailTabKey;
  onTabChange: (next: IssueDetailTabKey) => void;
  selectedSessionId: string | null;
  onSelectSession: (sid: string | null) => void;
  onPatch: (issueId: string, patch: IssuePatchInput) => void;
  onStatusUpdate: (issueId: string, data: { status: IssueStatus }) => void;
}

export function IssueDetailBody({
  issue,
  projectSlug,
  members,
  meProfile,
  isProjectOwner,
  activeTab,
  onTabChange,
  selectedSessionId,
  onSelectSession,
  onPatch,
  onStatusUpdate,
}: IssueDetailBodyProps) {
  const issueId = issue.id;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="min-w-0 space-y-6">
        <IssueDetailHeader
          issue={issue}
          projectSlug={projectSlug}
          onTitlePatch={onPatch}
          onStageJump={onTabChange}
        />
        <IssueDetailTabs
          active={activeTab}
          onChange={onTabChange}
          overview={
            <OverviewPanel issue={issue} issueId={issueId} onPatch={onPatch} />
          }
          plan={
            <PlanPanel
              issue={issue}
              issueId={issueId}
              projectSlug={projectSlug}
              onPatch={onPatch}
            />
          }
          activity={
            <ActivityPanel
              issueId={issueId}
              projectId={issue.projectId}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
            />
          }
          files={
            <FilesPanel
              issueId={issueId}
              projectId={issue.projectId}
              currentUserId={meProfile?.id ?? null}
              isProjectOwner={isProjectOwner}
            />
          }
        />
      </main>
      <aside className="space-y-4">
        <MetadataCard
          issue={issue}
          members={members}
          onStatusUpdate={onStatusUpdate}
          onPatch={onPatch}
        />
        <BranchConfigCard issue={issue} projectSlug={projectSlug} onPatch={onPatch} />
        <PipelineCard issue={issue} />
        <LinkedCard issue={issue} projectSlug={projectSlug} />
      </aside>
    </div>
  );
}

interface EditableSectionProps {
  title: string;
  value: string | null | undefined;
  placeholder: string;
  onSave: (value: string) => void;
}

function EditableMarkdownSection({ title, value, placeholder, onSave }: EditableSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          {title}
        </h3>
        {!editing && (
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      <div className="p-5 text-sm">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.max(6, Math.min(20, draft.split('\n').length + 2))}
              className="w-full resize-y rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
              placeholder={placeholder}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft(value ?? '');
                }}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  onSave(draft);
                  setEditing(false);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : value ? (
          <Markdown>{value}</Markdown>
        ) : (
          <span className="text-outline">{placeholder}</span>
        )}
      </div>
    </section>
  );
}

function CommentsSection({ issueId }: { issueId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const commentsQuery = useQuery({
    queryKey: commentsKey(issueId),
    queryFn: async () => {
      const tree = await apiClient<CoreCommentNode[]>(`/issues/${issueId}/comments`);
      return flattenCommentTree(tree);
    },
    enabled: !!issueId,
  });

  const createComment = useMutation({
    mutationFn: (body: string) =>
      apiClient<CoreComment>(`/issues/${issueId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: commentsKey(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });

  const comments = commentsQuery.data ?? [];

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Comments
        </h3>
      </div>
      <div className="space-y-4 p-5 text-sm">
        {commentsQuery.isLoading ? (
          <span className="text-outline">Loading comments…</span>
        ) : comments.length === 0 ? (
          <span className="text-outline">No comments yet</span>
        ) : (
          <ul className="space-y-3">
            {comments.map((c) => (
              <li
                key={c.id}
                className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-3"
              >
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-outline">
                  <span className="font-mono">{c.authorId.slice(0, 8)}</span>
                  <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
                </div>
                <Markdown>{c.body}</Markdown>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (!body) return;
            createComment.mutate(body);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment — markdown supported"
            rows={3}
            className="w-full resize-y rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
          {createComment.error && (
            <p className="text-[10px] uppercase tracking-widest text-error">
              {formatApiError(createComment.error)}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={createComment.isPending || !draft.trim()}
              size="sm"
            >
              {createComment.isPending ? 'Posting…' : 'Post comment'}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

function OverviewPanel({
  issue,
  issueId,
  onPatch,
}: {
  issue: Issue;
  issueId: string;
  onPatch: (issueIdValue: string, patch: IssuePatchInput) => void;
}) {
  return (
    <div className="space-y-6">
      <EditableMarkdownSection
        title="Description"
        value={issue.description}
        placeholder="No description. Click Edit to add one."
        onSave={(v) => onPatch(issueId, { description: v })}
      />
      <EditableMarkdownSection
        title="Acceptance Criteria"
        value={issue.acceptanceCriteria}
        placeholder="No acceptance criteria. Click Edit to add."
        onSave={(v) => onPatch(issueId, { acceptanceCriteria: v })}
      />
    </div>
  );
}

function PlanPanel({
  issue,
  issueId,
  projectSlug,
  onPatch,
}: {
  issue: Issue;
  issueId: string;
  projectSlug: string;
  onPatch: (issueIdValue: string, patch: IssuePatchInput) => void;
}) {
  return (
    <div className="space-y-6">
      <EditableMarkdownSection
        title="Plan"
        value={issue.plan}
        placeholder="No plan. Click Edit to add."
        onSave={(v) => onPatch(issueId, { plan: v })}
      />
      <EditableMarkdownSection
        title="Suggested Solution"
        value={issue.suggestedSolution}
        placeholder="No suggested solution. Click Edit to add."
        onSave={(v) => onPatch(issueId, { suggestedSolution: v })}
      />
      <IssueDecompositionPanel issueId={issueId} projectSlug={projectSlug} />
    </div>
  );
}

function ActivityPanel({
  issueId,
  projectId,
  selectedSessionId,
  onSelectSession,
}: {
  issueId: string;
  projectId: string;
  selectedSessionId: string | null;
  onSelectSession: (sid: string | null) => void;
}) {
  return (
    <div className="space-y-6">
      <IssuePipelineRunPanel
        issueId={issueId}
        projectId={projectId}
        onSelectSession={onSelectSession}
      />
      <IssuePipelineTiming projectId={projectId} />
      <CommentsSection issueId={issueId} />
      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Activity
          </h3>
        </div>
        <div className="p-5 text-sm">
          <IssueTimeline issueDocumentId={issueId} />
        </div>
      </section>
      <IssueAgentSessions
        issueId={issueId}
        onSelect={onSelectSession}
        selectedSessionId={selectedSessionId}
      />
      <IssueJobs issueId={issueId} projectId={projectId} />
    </div>
  );
}

function FilesPanel({
  issueId,
  projectId,
  currentUserId,
  isProjectOwner,
}: {
  issueId: string;
  projectId: string;
  currentUserId: string | null;
  isProjectOwner: boolean;
}) {
  return (
    <div className="space-y-6">
      <IssueAttachments
        issueId={issueId}
        currentUserId={currentUserId}
        isProjectOwner={isProjectOwner}
      />
      <section className="rounded-sm border border-outline-variant/20 bg-surface">
        <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Subtasks
          </h3>
        </div>
        <IssueTasks issueId={issueId} projectId={projectId} />
      </section>
      <IssueCostSummary issueId={issueId} />
    </div>
  );
}
