'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { formatStatusLabel } from '@/lib/utils/format-status';
import { useToast } from '@/hooks/use-toast';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineComplexitySelect } from '@/components/issue/inline-complexity-select';
import {
  IssueDetailStickyHeader,
  ManualHoldToggle,
} from '@/components/issue/issue-detail-sticky-header';
import { IssuePipelineActions } from '@/components/issue/issue-detail-modal/issue-pipeline-actions';
import { IssueAgentSessions } from '@/components/issue/issue-detail-modal/issue-agent-sessions';
import { IssueAttachments } from '@/components/issue/issue-detail-modal/issue-attachments';
import { useMeProfile } from '@/features/me/hooks/use-me';
import { IssueJobs } from '@/components/issue/issue-detail-modal/issue-jobs';
import { IssueTasks } from '@/components/issue/issue-detail-modal/issue-tasks';
import { IssueCostSummary } from '@/components/issue/issue-detail-modal/issue-cost-summary';
import { IssuePipelineTiming } from '@/components/issue/issue-pipeline-timing';
import { IssueRelations } from '@/components/issue/issue-relations';
import { IssueParentBreadcrumb } from '@/components/issue/issue-parent-breadcrumb';
import { IssueBlockedBanner } from '@/components/issue/issue-blocked-banner';
import { AgentSessionPanel } from '@/components/chat/agent-session-panel';
import type { Issue } from '@forge/contracts';
import type { IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';

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
      transitionIssue.mutate(
        { id: issueIdValue, toStatus: data.status },
        {
          onSuccess: () =>
            addToast(`Status updated to ${formatStatusLabel(data.status)}`),
          onError: (err) => addToast(`Update failed: ${formatApiError(err)}`),
        },
      );
    },
    [issue, transitionIssue, addToast],
  );

  const handlePatch = useCallback(
    (issueIdValue: string, patch: IssuePatchInput) => {
      patchIssue.mutate(
        { id: issueIdValue, patch },
        {
          onSuccess: () => {
            if ('assigneeId' in patch) {
              addToast('Assignee updated');
            } else if ('priority' in patch) {
              addToast(
                patch.priority
                  ? `Priority set to ${formatStatusLabel(patch.priority)}`
                  : 'Priority cleared',
              );
            } else if ('complexity' in patch) {
              addToast(
                patch.complexity
                  ? `Complexity set to ${formatStatusLabel(patch.complexity)}`
                  : 'Complexity cleared',
              );
            } else if ('category' in patch) {
              addToast(patch.category ? `Category set to ${patch.category}` : 'Category cleared');
            } else if (
              'description' in patch ||
              'acceptanceCriteria' in patch ||
              'suggestedSolution' in patch ||
              'plan' in patch
            ) {
              addToast('Saved');
            }
          },
          onError: (err) => addToast(`Update failed: ${formatApiError(err)}`),
        },
      );
    },
    [patchIssue, addToast],
  );

  const stickySentinelRef = useRef<HTMLDivElement | null>(null);

  const handleManualHoldToggle = useCallback(
    (id: string, next: boolean) => {
      setManualHold.mutate(
        { id, value: next },
        {
          onSuccess: () =>
            addToast(next ? 'Manual hold ON' : 'Manual hold released'),
          onError: (err) => addToast(`Update failed: ${formatApiError(err)}`),
        },
      );
    },
    [setManualHold, addToast],
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
  const splitOpen = !!sessionParam;

  return (
    <div className="relative">
      <IssueDetailStickyHeader
        issue={issue}
        members={members}
        sentinelRef={stickySentinelRef}
        onStatusUpdate={handleStatusUpdate}
        onPatch={handlePatch}
        onManualHoldToggle={(v) => handleManualHoldToggle(issueId, v)}
        manualHoldPending={setManualHold.isPending}
      />
      <div
        className={
          splitOpen
            ? 'mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-6'
            : 'mx-auto w-full max-w-7xl px-4 py-8 sm:px-8'
        }
      >
        <div className={splitOpen ? 'min-w-0' : ''}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <main className="min-w-0 space-y-6">
              <Breadcrumb slug={slug} displayId={issue.displayId} />
              <div ref={stickySentinelRef} aria-hidden className="h-px" />

              <header className="space-y-3">
                <h1 className="text-2xl font-bold text-primary">{issue.title}</h1>
                <IssueParentBreadcrumb
                  issueId={issueId}
                  projectSlug={slug}
                  currentDisplayId={issue.displayId}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <InlineStatusSelect issue={issue} onUpdate={handleStatusUpdate} />
                  <InlinePrioritySelect issue={issue} onUpdate={handlePatch} />
                  <InlineComplexitySelect issue={issue} onUpdate={handlePatch} />
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                      Assignee
                    </span>
                    <AssigneePicker
                      value={issue.assigneeId ?? null}
                      members={members}
                      onChange={(assigneeId) => handlePatch(issueId, { assigneeId })}
                    />
                  </span>
                  {issue.category && (
                    <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                      {issue.category}
                    </span>
                  )}
                  <ManualHoldToggle
                    value={issue.manualHold ?? false}
                    pending={setManualHold.isPending}
                    onToggle={(v) => handleManualHoldToggle(issueId, v)}
                  />
                </div>
                <IssuePipelineActions issueId={issueId} status={issue.status} />
              </header>

              <IssueBlockedBanner issueId={issueId} />

              <EditableMarkdownSection
                title="Description"
                value={issue.description}
                placeholder="No description. Click Edit to add one."
                onSave={(v) => handlePatch(issueId, { description: v })}
              />

              <EditableMarkdownSection
                title="Acceptance Criteria"
                value={issue.acceptanceCriteria}
                placeholder="No acceptance criteria. Click Edit to add."
                onSave={(v) => handlePatch(issueId, { acceptanceCriteria: v })}
              />

              <EditableMarkdownSection
                title="Suggested Solution"
                value={issue.suggestedSolution}
                placeholder="No suggested solution. Click Edit to add."
                onSave={(v) => handlePatch(issueId, { suggestedSolution: v })}
              />

              <EditableMarkdownSection
                title="Plan"
                value={issue.plan}
                placeholder="No plan. Click Edit to add."
                onSave={(v) => handlePatch(issueId, { plan: v })}
              />

              <section className="rounded-sm border border-outline-variant/20 bg-surface">
                <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
                    Subtasks
                  </h3>
                </div>
                <IssueTasks issueId={issueId} projectId={issue.projectId} />
              </section>

              <IssueAttachments
                issueId={issueId}
                currentUserId={meProfile?.id ?? null}
                isProjectOwner={!!meProfile && project?.ownerId === meProfile.id}
              />

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
                onSelect={(sid) => setSessionId(sid)}
                selectedSessionId={sessionParam}
              />
              <IssueJobs issueId={issueId} projectId={issue.projectId} />
            </main>

            <aside className="space-y-6">
              <IssueCostSummary issueId={issueId} />
              <IssuePipelineTiming projectId={issue.projectId} />
              <IssueRelations
                issueId={issueId}
                projectId={issue.projectId}
                projectSlug={slug}
              />
            </aside>
          </div>
        </div>

        {splitOpen && sessionParam && (
          <SessionSplitPane
            sessionId={sessionParam}
            projectSlug={slug}
            onClose={() => setSessionId(null)}
          />
        )}
      </div>
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

function SessionSplitPane({
  sessionId,
  projectSlug,
  onClose,
}: {
  sessionId: string;
  projectSlug: string;
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
          onOpenFull={() => router.push(`/projects/${projectSlug}/agent?session=${sessionId}`)}
        />
      </div>
    </div>
  );
}
