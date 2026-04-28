'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useAuth } from '@/providers/auth-provider';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  agentApi,
  AGENT_INTERACTIVE_ENABLED,
  type AgentSessionSummary,
  type BranchDiff,
} from '@/features/agent/api';

export type ViewTab = 'chat' | 'changes';

export function useAgentPage() {
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionParam = searchParams.get('session');

  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(true);
  const suppressUrlSync = useRef(false);

  const [viewTab, setViewTab] = useState<ViewTab>('chat');
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [editablePrompt, setEditablePrompt] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const { user } = useAuth();
  const streamCtx = useAgentStreamContext();
  const {
    messages,
    isRunning,
    sessionId,
    desktopConnected,
    draftPrompt,
    isBuildingPrompt,
    pendingIssueIds,
    startAgent,
    sendMessage,
    abortAgent,
    loadSession,
    resetSession,
    clearDraftPrompt,
    usage,
  } = streamCtx;

  const fetchSessions = useCallback(async (search?: string) => {
    if (!projectId) return;
    try {
      const res = await agentApi.getSessions(projectId, search);
      setSessions(res.data || []);
    } catch {
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [projectId]);

  // Initial load
  useEffect(() => {
    if (!projectId) return;
    fetchSessions();
  }, [fetchSessions, projectId]);

  // Refresh sessions list when a session completes
  useEffect(() => {
    if (!isRunning && sessionId) {
      fetchSessions();
    }
  }, [isRunning, sessionId, fetchSessions]);

  // Sync activeSessionId with hook's sessionId
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
  }, [sessionId]);

  // Load session from URL ?session= param on initial mount
  useEffect(() => {
    if (sessionParam && !sessionId) {
      suppressUrlSync.current = true;
      setActiveSessionId(sessionParam);
      loadSession(sessionParam);
      setShowSessions(false);
    }
  }, [sessionParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync activeSessionId → URL ?session= param
  useEffect(() => {
    if (suppressUrlSync.current) {
      suppressUrlSync.current = false;
      return;
    }
    if (activeSessionId && activeSessionId !== sessionParam) {
      router.replace(`/projects/${slug}/agent?session=${activeSessionId}`, { scroll: false });
    } else if (!activeSessionId && sessionParam) {
      router.replace(`/projects/${slug}/agent`, { scroll: false });
    }
  }, [activeSessionId, sessionParam, slug, router]);

  // When draft prompt arrives from an issue trigger, auto-send it.
  // If pendingIssueIds exist it came from a trigger button — send immediately.
  // Otherwise just populate the editor for manual review. Skipped while the
  // agent page is read-only (AGENT_INTERACTIVE_ENABLED) so we don't fire
  // start/send against unimplemented core endpoints.
  useEffect(() => {
    if (!AGENT_INTERACTIVE_ENABLED) return;
    if (draftPrompt) {
      setShowSessions(false);
      if (pendingIssueIds && pendingIssueIds.length > 0) {
        startAgent(draftPrompt, { preBuilt: true, issueIds: pendingIssueIds });
        clearDraftPrompt();
        setEditablePrompt('');
      } else {
        setEditablePrompt(draftPrompt);
      }
    }
  }, [draftPrompt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch diff data when switching to changes tab
  useEffect(() => {
    if (viewTab !== 'changes' || !sessionId) return;
    setDiffLoading(true);
    agentApi.getSession(sessionId)
      .then((res) => setDiff(res.data?.diff ?? null))
      .catch(() => setDiff(null))
      .finally(() => setDiffLoading(false));
  }, [viewTab, sessionId]);

  // Reset diff when session changes
  useEffect(() => {
    setDiff(null);
    setViewTab('chat');
  }, [sessionId]);

  // Auto-switch back to chat when running
  useEffect(() => {
    if (isRunning) setViewTab('chat');
  }, [isRunning]);

  const handleNewChat = useCallback(() => {
    resetSession();
    setActiveSessionId(null);
    setShowSessions(false);
    setDiff(null);
    setViewTab('chat');
  }, [resetSession]);

  const handleSearchSessions = useCallback((query: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchSessions(query), 300);
  }, [fetchSessions]);

  const handleSelectSession = useCallback((session: AgentSessionSummary) => {
    setActiveSessionId(session.documentId);
    loadSession(session.documentId);
    setShowSessions(false);
  }, [loadSession]);

  const handleSend = useCallback((text: string) => {
    if (!text.trim()) return;
    if (sessionId) {
      sendMessage(text);
    } else {
      startAgent(text);
    }
  }, [sessionId, sendMessage, startAgent]);

  const handleStartFromPrompt = useCallback(() => {
    if (editablePrompt.trim()) {
      startAgent(editablePrompt, { preBuilt: true, issueIds: pendingIssueIds ?? undefined });
      clearDraftPrompt();
      setEditablePrompt('');
    }
  }, [editablePrompt, startAgent, pendingIssueIds, clearDraftPrompt]);

  const handleCancelDraft = useCallback(() => {
    clearDraftPrompt();
    setEditablePrompt('');
  }, [clearDraftPrompt]);

  const activeSession = sessions.find((s) => s.documentId === sessionId);
  const isCompleted = activeSession?.status === 'completed' || activeSession?.status === 'failed';
  const hasMessages = messages.length > 0;
  const showChangesTab = hasMessages && !isRunning && isCompleted;
  // No active session = new chat (user can send); active session = check ownership
  // F2 rewires this page onto packages/core jobs. In F1 we only need the
  // typecheck to pass — legacy session.user.id is numeric; core user.id is
  // a uuid string. Compare loosely; this call site is rewritten in F2.
  const isSessionOwner =
    !activeSession ||
    !activeSession.user ||
    String(activeSession.user.id) === String(user?.id ?? '');

  return {
    slug,
    sessions,
    loadingSessions,
    activeSessionId,
    showSessions,
    setShowSessions,
    viewTab,
    setViewTab,
    diff,
    diffLoading,
    editablePrompt,
    setEditablePrompt,
    messages,
    isRunning,
    sessionId,
    desktopConnected,
    draftPrompt,
    isBuildingPrompt,
    usage,
    abortAgent,
    showChangesTab,
    handleNewChat,
    handleSearchSessions,
    handleSelectSession,
    handleSend,
    handleStartFromPrompt,
    handleCancelDraft,
    isSessionOwner,
  };
}
