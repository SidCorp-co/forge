'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useAuth } from '@/providers/auth-provider';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { type AgentSessionSummary } from '@/features/agent/api';
import {
  useAgentSessions,
  useAgentSession,
} from '@/features/agent/hooks/use-agents';

export type ViewTab = 'chat' | 'changes';

const RELAY_TIMEOUT_MS = 15_000;

export function useAgentPage() {
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionParam = searchParams.get('session');

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(true);
  const suppressUrlSync = useRef(false);

  const [viewTab, setViewTab] = useState<ViewTab>('chat');
  const [editablePrompt, setEditablePrompt] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const { user } = useAuth();
  const queryClient = useQueryClient();
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
    connectionState,
    reconnectNow,
    forkSession,
    rerunSession,
  } = streamCtx;

  const sessionsQuery = useAgentSessions(projectId, {
    search: searchQuery,
    refetchInterval: isRunning ? 15_000 : false,
  });
  const sessions: AgentSessionSummary[] = sessionsQuery.data ?? [];
  const loadingSessions = sessionsQuery.isLoading;

  // Read the persisted diff straight from the per-session cache so the
  // Changes tab does not re-fetch when the row was already loaded by the
  // running poll or a WS-driven invalidation.
  const sessionDetailQuery = useAgentSession(
    viewTab === 'changes' ? sessionId : null,
  );
  const diff = sessionDetailQuery.data?.diff ?? null;
  const diffLoading = sessionDetailQuery.isLoading;

  // Sync activeSessionId with hook's sessionId
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
  }, [sessionId]);

  // Optimistic insert: when a brand-new session id appears (start), prepend
  // a stub row to the cached list so the sidebar reflects the action before
  // the WS-driven invalidation lands. The next refetch reconciles the row
  // with the server-side fields (metadata, user, lifecycle stamps).
  useEffect(() => {
    if (!sessionId || !projectId) return;
    queryClient.setQueriesData<{ data: AgentSessionSummary[] } | undefined>(
      { queryKey: ['agent-sessions', projectId, 'all'] },
      (prev) => {
        if (!prev) return prev;
        const rows = prev.data || [];
        if (rows.some((r) => r.documentId === sessionId)) return prev;
        const now = new Date().toISOString();
        const stub = {
          documentId: sessionId,
          title: '',
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        } as AgentSessionSummary;
        return { ...prev, data: [stub, ...rows] };
      },
    );
  }, [sessionId, projectId, queryClient]);

  // Load session from URL ?session= param. Gate on activeSessionId (sync
  // state) instead of the stream-context sessionId (async dispatch), so a
  // click → URL-replace → effect-rerun loop sees activeSessionId already
  // committed and skips the second loadSession.
  useEffect(() => {
    if (sessionParam && sessionParam !== activeSessionId) {
      suppressUrlSync.current = true;
      setActiveSessionId(sessionParam);
      loadSession(sessionParam);
      setShowSessions(false);
    }
  }, [sessionParam, activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Otherwise just populate the editor for manual review.
  useEffect(() => {
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

  // Reset to chat tab when the active session changes — react-query keys
  // on `sessionId` so the diff cache resets implicitly.
  useEffect(() => {
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
    setViewTab('chat');
  }, [resetSession]);

  const handleSearchSessions = useCallback((query: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearchQuery(query), 300);
  }, []);

  const handleSelectSession = useCallback((session: AgentSessionSummary) => {
    setActiveSessionId(session.documentId);
    loadSession(session.documentId);
    setShowSessions(false);
  }, [loadSession]);

  const handleAfterFork = useCallback((newId: string) => {
    setActiveSessionId(newId);
    loadSession(newId);
    setShowSessions(false);
  }, [loadSession]);

  const handleRerun = useCallback(async () => {
    if (!sessionId) return;
    if (!window.confirm('Rerun this session from scratch? This will start a new session with the same prompt.')) return;
    const newId = await rerunSession();
    if (newId) {
      setActiveSessionId(newId);
      loadSession(newId);
    }
  }, [sessionId, rerunSession, loadSession]);

  // Layer 2 — runner pickup timeout. The client-side optimistic user echo from
  // startAgent / sendMessage inflates user-role messages immediately, so we
  // gate on assistant-role count instead — only a real runner produces those.
  const [sendAt, setSendAt] = useState<number | null>(null);
  const [relayTimedOut, setRelayTimedOut] = useState(false);
  const lastSendTextRef = useRef<string | null>(null);
  const assistantBaselineRef = useRef(0);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const handleSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    assistantBaselineRef.current = messagesRef.current.filter((m) => m.role === 'assistant').length;
    lastSendTextRef.current = trimmed;
    setRelayTimedOut(false);
    setSendAt(Date.now());
    if (sessionId) {
      sendMessage(trimmed);
    } else {
      startAgent(trimmed);
    }
  }, [sessionId, sendMessage, startAgent]);

  useEffect(() => {
    if (sendAt === null) return;
    const count = messages.filter((m) => m.role === 'assistant').length;
    if (count > assistantBaselineRef.current) {
      setSendAt(null);
      setRelayTimedOut(false);
    }
  }, [messages, sendAt]);

  useEffect(() => {
    if (sendAt === null) return;
    const t = setTimeout(() => setRelayTimedOut(true), RELAY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [sendAt]);

  useEffect(() => {
    setSendAt(null);
    setRelayTimedOut(false);
    lastSendTextRef.current = null;
  }, [sessionId]);

  const handleRetrySend = useCallback(() => {
    const text = lastSendTextRef.current;
    if (!text) return;
    setRelayTimedOut(false);
    handleSend(text);
  }, [handleSend]);

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
    handleRetrySend,
    relayTimedOut,
    isSessionOwner,
    connectionState,
    reconnectNow,
    handleAfterFork,
    handleRerun,
    isTerminal: isCompleted,
  };
}
