'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { ToastContainer } from '@/components/ui';
import {
  useIssue,
  useIssueByDisplay,
  usePatchIssue,
  useTransitionIssue,
  useSetManualHold,
} from '@/features/issue/hooks/use-issues';
import { useProjectBySlug, useProjects } from '@/features/project/hooks/use-projects';
import { useProjectMembers } from '@/features/project/hooks/use-project-members';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/hooks/use-toast';
import { useMeProfile } from '@/features/me/hooks/use-me';
import { IssueDetailBody } from '@/components/issue/issue-detail-body';
import { type IssueDetailTabKey } from '@/components/issue/issue-detail-tabs';
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
  const hasSession = !!sessionParam;
  const showSplit = hasSession && pinned;
  const showDrawer = hasSession && !pinned;
  const isProjectOwner = !!meProfile && project?.ownerId === meProfile.id;

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
          <Breadcrumb slug={slug} displayId={issue.displayId} />
          <IssueDetailBody
            issue={issue}
            projectSlug={slug}
            members={members}
            meProfile={meProfile ?? null}
            isProjectOwner={isProjectOwner}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedSessionId={sessionParam}
            onSelectSession={setSessionId}
            onPatch={handlePatch}
            onStatusUpdate={handleStatusUpdate}
            onSetManualHold={(v) => setManualHold.mutate({ id: issueId, value: v })}
            manualHoldPending={setManualHold.isPending}
          />
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
    <div className="mb-6 flex items-center gap-2 text-[10px] uppercase tracking-widest text-outline">
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
