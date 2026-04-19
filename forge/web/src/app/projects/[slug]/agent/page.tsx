'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { Plus, Monitor, MonitorOff, List, X, Play, Loader2, Crown } from 'lucide-react';
import { ChatMessages } from '@/components/chat/chat-messages';
import { ChatInput } from '@/components/chat/chat-input';
import { SessionList } from '@/components/chat/session-list';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useAuth } from '@/providers/auth-provider';
import { agentApi, type AgentSession, type AgentSessionSummary } from '@/features/agent/api';
import { uploadAndFormatMessage } from '@/lib/utils/upload-files';

import { cn } from '@/lib/utils/cn';
import { ContextUsageBar } from '@/components/chat/context-usage-bar';
import { StatusDot } from '@/components/ui/status-dot';
import { Button } from '@/components/ui/button';
import { useProject } from '@/features/project/hooks/use-projects';

export default function AgentPage() {
  const { user } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionParam = searchParams.get('session');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(true);
  const suppressUrlSync = useRef(false);
  const { data: projectData } = useProject(slug);
  const isCeoProject = !!projectData?.data?.crossProjectAccess;

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
  } = useAgentStreamContext();
  const [editablePrompt, setEditablePrompt] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const fetchSessions = useCallback(async (search?: string) => {
    try {
      const res = await agentApi.getSessions(slug, search);
      setSessions(res.data || []);
    } catch {
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

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

  // When draft prompt arrives from desktop, populate the editor
  useEffect(() => {
    if (draftPrompt) {
      setEditablePrompt(draftPrompt);
      setShowSessions(false);
    }
  }, [draftPrompt]);

  const handleNewChat = () => {
    resetSession();
    setActiveSessionId(null);
    setShowSessions(false);
  };

  const handleSearchSessions = useCallback((query: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchSessions(query), 300);
  }, [fetchSessions]);

  const handleSelectSession = (session: AgentSessionSummary) => {
    setActiveSessionId(session.documentId);
    loadSession(session.documentId);
    setShowSessions(false);
  };

  const handleSend = useCallback(async (text: string, files?: File[]) => {
    if (!text.trim() && (!files || files.length === 0)) return;
    const messageText = await uploadAndFormatMessage(text, files);
    if (sessionId) {
      sendMessage(messageText);
    } else {
      startAgent(messageText);
    }
  }, [sessionId, sendMessage, startAgent]);

  // Determine if current user owns the active session
  const activeSession = sessions.find((s) => s.documentId === (sessionId || activeSessionId));
  const isMySession = !sessionId || !activeSession?.user || activeSession.user.id === user?.id;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {isCeoProject && user?.isCEO && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-sm text-amber-600">
          <Crown className="h-4 w-4" />
          <span className="font-medium">CEO Mode</span>
          <span className="text-amber-500/70">Cross-project access enabled</span>
        </div>
      )}
    <div className="flex flex-1 min-h-0 bg-background overflow-hidden md:rounded-lg md:border md:border-surface-variant">
      {/* Sessions sidebar — hidden on mobile when chat is shown */}
      <div className={cn(
        'w-full shrink-0 border-r border-surface-variant flex flex-col bg-surface md:w-64',
        !showSessions && 'hidden md:flex'
      )}>
        <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
          <h3 className="text-sm font-semibold text-on-surface-variant">Sessions</h3>
          <Button size="xs" onClick={handleNewChat} className="flex items-center gap-1">
            <Plus className="h-3 w-3" />
            New
          </Button>
        </div>

        {/* Desktop status */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-variant text-xs">
          {desktopConnected ? (
            <>
              <Monitor className="h-3.5 w-3.5 text-success" />
              <span className="text-success">Desktop connected</span>
            </>
          ) : (
            <>
              <MonitorOff className="h-3.5 w-3.5 text-primary-fixed" />
              <span className="text-primary-fixed">Desktop offline</span>
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain">
          <SessionList
            sessions={sessions}
            loading={loadingSessions}
            activeSessionId={activeSessionId}
            onSelect={handleSelectSession}
            onNew={handleNewChat}
            statusDot={(s) => <StatusDot status={s.status} />}
            getHref={(s) => `/projects/${slug}/agent?session=${s.documentId}`}
            theme="dark"
            onSearch={handleSearchSessions}
          />
        </div>
      </div>

      {/* Chat area — hidden on mobile when sessions list is shown */}
      <div className={cn(
        'flex-1 min-h-0 min-w-0 flex flex-col',
        showSessions && 'hidden md:flex'
      )}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-variant bg-surface px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setShowSessions(true)}
              className="rounded p-2 text-primary-fixed hover:text-outline md:hidden shrink-0"
              aria-label="Show sessions"
            >
              <List className="h-4 w-4" />
            </button>
            <h3 className="text-sm font-semibold text-on-surface-variant truncate" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
              {sessionId ? (sessions.find((s) => s.documentId === sessionId)?.title || 'Agent Chat') : 'New Agent Chat'}
            </h3>
            <ContextUsageBar usage={usage} />
          </div>
        </div>

        {/* Prompt review/edit — shown when desktop builds a prompt from an issue */}
        {(draftPrompt || isBuildingPrompt) && !sessionId ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {isBuildingPrompt && !draftPrompt ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex items-center gap-2 text-outline">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Desktop is building prompt...</span>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-surface-variant shrink-0">
                  <span className="text-xs text-outline">Review and edit the prompt before starting</span>
                  <button
                    onClick={() => { clearDraftPrompt(); setEditablePrompt(''); }}
                    className="p-1 text-primary-fixed hover:text-outline"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                  <textarea
                    value={editablePrompt}
                    onChange={(e) => setEditablePrompt(e.target.value)}
                    className="min-h-[60vh] h-full w-full resize-none rounded-lg border border-surface-variant bg-surface p-4 text-sm text-on-surface-variant font-mono focus:border-primary-fixed focus:outline-none"
                  />
                </div>
                <div className="flex justify-end gap-2 border-t border-surface-variant px-4 py-3 shrink-0">
                  <button
                    onClick={() => { clearDraftPrompt(); setEditablePrompt(''); }}
                    className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-xs text-outline hover:bg-surface-container"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (editablePrompt.trim()) {
                        startAgent(editablePrompt, { preBuilt: true, issueIds: pendingIssueIds ?? undefined });
                        clearDraftPrompt();
                        setEditablePrompt('');
                      }
                    }}
                    disabled={!editablePrompt.trim()}
                    className="flex items-center gap-1.5 rounded-lg bg-success px-3 py-2 text-xs font-medium text-white hover:bg-success disabled:opacity-50"
                  >
                    <Play className="h-3 w-3" />
                    Start Session
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Messages */}
            <ChatMessages messages={messages} />

            {/* Input — not disabled while running, but shows stop button */}
            <ChatInput
              onSend={(text, files) => handleSend(text, files)}
              isRunning={isRunning}
              onStop={isMySession ? abortAgent : undefined}
              disabled={!isMySession}
            />
          </>
        )}
      </div>
    </div>
    </div>
  );
}
