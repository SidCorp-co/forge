'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Markdown } from '@/components/ui/markdown';
import { Button, ToastContainer } from '@/components/ui';
import {
  issueKeys,
  useIssue,
  useIssueByDisplay,
  usePatchIssue,
  useTransitionIssue,
  useSetManualHold,
} from '@/features/issue/hooks/use-issues';
import { useProjectBySlug, useProjects } from '@/features/project/hooks/use-projects';
import { useProjectMembers } from '@/features/project/hooks/use-project-members';
import { IssueTimeline } from '@/components/issue/issue-timeline';
import { apiClient } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/hooks/use-toast';
import { IssuePipelineRunPanel } from '@/components/issue/issue-detail-modal/issue-pipeline-run-panel';
import { IssueAgentSessions } from '@/components/issue/issue-detail-modal/issue-agent-sessions';
import { IssueAttachments } from '@/components/issue/issue-detail-modal/issue-attachments';
import { useMeProfile } from '@/features/me/hooks/use-me';
import { IssueJobs } from '@/components/issue/issue-detail-modal/issue-jobs';
import { IssueTasks } from '@/components/issue/issue-detail-modal/issue-tasks';
import { IssueCostSummary } from '@/components/issue/issue-detail-modal/issue-cost-summary';
import { IssuePipelineTiming } from '@/components/issue/issue-pipeline-timing';
import { IssueDecompositionPanel } from '@/components/issue/issue-decomposition-panel';
import { IssueDetailTabs, type IssueDetailTabKey } from '@/components/issue/issue-detail-tabs';
import { MetadataCard } from '@/components/issue/aside/metadata-card';
import { PipelineCard } from '@/components/issue/aside/pipeline-card';
import { LinkedCard } from '@/components/issue/aside/linked-card';
import { AgentSessionPanel } from '@/components/chat/agent-session-panel';
import { AgentSessionDrawer } from '@/components/chat/agent-session-drawer';
import { useUserPref } from '@/features/me/hooks/use-user-prefs';
import type { Issue } from '@forge/contracts';
import type { IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';

const TAB_KEYS = ['overview', 'plan', 'activity', 'files'] as const;
function parseTab(raw: string | null): IssueDetailTabKey {
  return (TAB_KEYS as readonly string[]).includes(raw ?? '')
    ? (raw as IssueDetailTabKey)
    : 'overview';
}

const HASH_TO_TAB: Record<string, IssueDetailTabKey> = {
  comments: 'activity',
  timeline: 'activity',
  activity: 'activity',
  plan: 'plan',
  attachments: 'files',
  tasks: 'files',
};

const DISPLAY_ID_RE = /^ISS-\d+$/i;

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

export default function IssueDetailPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get('session');
  const isDisplayId = DISPLAY_ID_RE.test(id);
  const [pinned, setPinned] = useUserPref('agentDrawerPinned');

  const projectsQuery = useProjects();
  const project = useProjectBySlug(isDisplayId ? slug : undefined);
  const projectId = project?.id;
  const projectMissing = isDisplayId && !projectsQuery.isLoading && !projectId;

  const byUuid = useIssue(isDisplayId ? undefined : id);
  const byDisplay = useIssueByDisplay(
    isDisplayId ? projectId : undefined,
    isDisplayId ? id : undefined,
  );

  const issue = (isDisplayId ? byDisplay.data : byUuid.data) as Issue | undefined;
  const error = isDisplayId ? byDisplay.error : byUuid.error;
  const isLoading = isDisplayId
    ? !projectMissing && (projectsQuery.isLoading || (!!projectId && byDisplay.isLoading))
    : byUuid.isLoading;

  const transitionIssue = useTransitionIssue();
  const patchIssue = usePatchIssue();
  const setManualHold = useSetManualHold();
  const { toasts, addToast } = useToast();
  const { data: members = [] } = useProjectMembers(projectId);
  const { data: meProfile } = useMeProfile();

  const handleStatusUpdate = useCallback(
    (issueIdValue: string, data: { status: IssueStatus }) => {
      if (issue && data.status === issue.status) return;
      transitionIssue.mutate({ id: issueIdValue, toStatus: data.status });
    },
    [issue, transitionIssue],
  );

  const handlePatch = useCallback(
    (issueIdValue: string, patch: IssuePatchInput) => {
      patchIssue.mutate(
        { id: issueIdValue, patch },
        {
          onSuccess: () => {
            if (Object.prototype.hasOwnProperty.call(patch, 'assigneeId')) {
              addToast('Assignee updated');
            }
          },
        },
      );
    },
    [patchIssue, addToast],
  );

  const setSessionId = useCallback(
    (sid: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (sid) params.set('session', sid);
      else params.delete('session');
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [router, searchParams],
  );

  const activeTab = parseTab(searchParams.get('tab'));
  const setActiveTab = useCallback(
    (next: IssueDetailTabKey) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [router, searchParams],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const target = HASH_TO_TAB[hash];
    if (target) {
      const params = new URLSearchParams(window.location.search);
      if (target === 'overview') params.delete('tab');
      else params.set('tab', target);
      const qs = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${qs ? `?${qs}` : ''}`,
      );
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    } else {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const issueId = issue.id;
  const transitionError = transitionIssue.error;
  const patchError = patchIssue.error;
  const hasSession = !!sessionParam;
  const showSplit = hasSession && pinned;
  const showDrawer = hasSession && !pinned;

  return (
    <div className="relative">
      <div
        className={
          showSplit
            ? 'mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-6'
            : 'mx-auto w-full max-w-7xl px-4 py-8 sm:px-8'
        }
      >
        <div className={showSplit ? 'min-w-0' : ''}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <main className="min-w-0 space-y-6">
              <Breadcrumb slug={slug} displayId={issue.displayId} />

              <header className="space-y-3">
                <h1 className="text-2xl font-bold text-primary">{issue.title}</h1>
                {(transitionError || patchError) && (
                  <p className="text-[10px] uppercase tracking-widest text-error">
                    {formatApiError(transitionError ?? patchError)}
                  </p>
                )}
              </header>

              <IssueDetailTabs
                active={activeTab}
                onChange={setActiveTab}
                overview={
                  <OverviewPanel
                    issue={issue}
                    issueId={issueId}
                    onPatch={handlePatch}
                  />
                }
                plan={
                  <PlanPanel
                    issue={issue}
                    issueId={issueId}
                    projectSlug={slug}
                    onPatch={handlePatch}
                  />
                }
                activity={
                  <ActivityPanel
                    issueId={issueId}
                    projectId={issue.projectId}
                    selectedSessionId={sessionParam}
                    onSelectSession={setSessionId}
                  />
                }
                files={
                  <FilesPanel
                    issueId={issueId}
                    projectId={issue.projectId}
                    currentUserId={meProfile?.id ?? null}
                    isProjectOwner={!!meProfile && project?.ownerId === meProfile.id}
                  />
                }
              />
            </main>
            <aside className="space-y-4">
              <MetadataCard
                issue={issue}
                members={members}
                onStatusUpdate={handleStatusUpdate}
                onPatch={handlePatch}
              />
              <PipelineCard
                issue={issue}
                manualHoldPending={setManualHold.isPending}
                onSetManualHold={(v) => setManualHold.mutate({ id: issueId, value: v })}
              />
              <LinkedCard issue={issue} projectSlug={slug} />
            </aside>
          </div>
        </div>

        {showSplit && sessionParam && (
          <SessionSplitPane
            sessionId={sessionParam}
            projectSlug={slug}
            pinned
            onTogglePin={() => setPinned(false)}
            onClose={() => setSessionId(null)}
          />
        )}
      </div>

      {showDrawer && sessionParam && (
        <AgentSessionDrawer
          sessionId={sessionParam}
          projectSlug={slug}
          onTogglePin={() => setPinned(true)}
          onClose={() => setSessionId(null)}
        />
      )}

      <ToastContainer toasts={toasts} />
    </div>
  );
}

function Breadcrumb({ slug, displayId }: { slug: string; displayId: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-outline">
      <Link
        href={`/projects/${slug}/issues`}
        className="transition-colors hover:text-on-surface"
      >
        Issues
      </Link>
      <span className="text-outline-variant">/</span>
      <span className="font-mono text-primary tracking-widest">{displayId}</span>
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

function SessionSplitPane({
  sessionId,
  projectSlug,
  pinned,
  onTogglePin,
  onClose,
}: {
  sessionId: string;
  projectSlug: string;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <div className="fixed inset-0 z-40 flex bg-on-primary/40 backdrop-blur-sm md:relative md:inset-auto md:z-auto md:block md:bg-transparent md:backdrop-blur-none">
      <div className="ml-auto flex h-full w-full flex-col border-l border-outline-variant/20 bg-surface md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)] md:rounded-sm md:border md:shadow-lg">
        <AgentSessionPanel
          sessionId={sessionId}
          projectSlug={projectSlug}
          onClose={onClose}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onOpenFull={() => router.push(`/projects/${projectSlug}/agent?session=${sessionId}`)}
        />
      </div>
    </div>
  );
}
