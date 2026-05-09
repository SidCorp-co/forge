'use client';

import Link from 'next/link';
import { ExternalLink, Monitor, MonitorOff, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, type AgentSessionSummary } from '@/features/agent/api';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { usePageContext, useProjectChatState } from '@/features/project-chat';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { uploadAndFormatMessage } from '@/lib/utils/upload-files';
import { cn } from '@/lib/utils/cn';
import { ChatInput } from './chat-input';
import { ChatMessages } from './chat-messages';
import { ContextUsageBar } from './context-usage-bar';
import { SessionList } from './session-list';

interface ProjectChatPanelProps {
  projectSlug: string;
}

/**
 * Slide-over chat surface anchored right on desktop and full-screen on
 * mobile. Reuses the layout-level `AgentStreamProvider`, so panel state
 * (sessionId, isRunning, draftPrompt) survives navigation between project
 * sub-pages.
 */
export function ProjectChatPanel({ projectSlug }: ProjectChatPanelProps) {
  const project = useProjectBySlug(projectSlug);
  const { tab, setTab, sessionId: urlSessionId, setSessionId, close } =
    useProjectChatState();
  const pageContext = usePageContext();

  const stream = useAgentStreamContext();
  const {
    messages,
    isRunning,
    sessionId,
    desktopConnected,
    draftPrompt,
    usage,
    startAgent,
    sendMessage,
    abortAgent,
    loadSession,
    resetSession,
    clearDraftPrompt,
  } = stream;

  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [editablePrompt, setEditablePrompt] = useState('');

  // Hydrate from URL on first mount (?chatSession=<id>) — only when the
  // layout-level stream has no session loaded yet. If the stream already
  // holds a different session (the user was actively chatting before
  // opening the bubble), trust the stream and let the mirror effect below
  // align the URL.
  useEffect(() => {
    if (urlSessionId && !sessionId) {
      loadSession(urlSessionId);
      setTab('chat');
    }
  }, [urlSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror stream sessionId back into the URL so reload restores the same chat.
  // Only mirror when the stream has a real sessionId; clearing the URL on a
  // first mount with `sessionId=null` would wipe `?chatSession=<id>` before
  // `loadSession` resolves. Explicit clears (e.g. handleNewChat) call
  // `setSessionId(null)` directly.
  useEffect(() => {
    if (sessionId && sessionId !== urlSessionId) setSessionId(sessionId);
  }, [sessionId, urlSessionId, setSessionId]);

  const refreshSessions = useCallback(async () => {
    if (!project?.id) return;
    setLoadingSessions(true);
    try {
      const res = await agentApi.getSessions(project.id);
      setSessions(res.data || []);
    } catch {
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [project?.id]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Re-fetch session list when an active stream finishes (running → !running)
  // so the sidebar reflects the new "completed" status. Guarded by a ref so
  // unrelated isRunning identity changes don't fan out duplicate fetches.
  const lastIsRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = lastIsRunningRef.current;
    lastIsRunningRef.current = isRunning;
    if (wasRunning && !isRunning && sessionId) refreshSessions();
  }, [isRunning, sessionId, refreshSessions]);

  // Surface draft prompt for editing when no session active.
  useEffect(() => {
    if (draftPrompt && !sessionId) setEditablePrompt(draftPrompt);
  }, [draftPrompt, sessionId]);

  const handleSend = useCallback(
    async (text: string, files?: File[]) => {
      if (!text.trim() && (!files || files.length === 0)) return;
      const messageText = await uploadAndFormatMessage(text, files);
      const ctx = pageContext ?? undefined;
      if (sessionId) {
        sendMessage(messageText, { pageContext: ctx });
      } else {
        startAgent(messageText, { pageContext: ctx });
      }
    },
    [sessionId, sendMessage, startAgent, pageContext],
  );

  const handleStartFromDraft = useCallback(() => {
    if (!editablePrompt.trim()) return;
    startAgent(editablePrompt, {
      preBuilt: true,
      pageContext: pageContext ?? undefined,
    });
    clearDraftPrompt();
    setEditablePrompt('');
  }, [editablePrompt, startAgent, clearDraftPrompt, pageContext]);

  const handleCancelDraft = useCallback(() => {
    clearDraftPrompt();
    setEditablePrompt('');
  }, [clearDraftPrompt]);

  const handleNewChat = useCallback(() => {
    resetSession();
    setSessionId(null);
    setTab('chat');
    setEditablePrompt('');
  }, [resetSession, setSessionId, setTab]);

  const handleSelectSession = useCallback(
    (s: AgentSessionSummary) => {
      loadSession(s.documentId);
      setSessionId(s.documentId);
      setTab('chat');
    },
    [loadSession, setSessionId, setTab],
  );

  const fullViewHref = `/projects/${projectSlug}/agent${
    sessionId ? `?session=${sessionId}` : ''
  }`;

  const showDraftEditor =
    tab === 'chat' && !sessionId && !!editablePrompt && messages.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop click-outside — only visible on desktop where aside is
          400px wide; mobile relies on the X button to close. */}
      <button
        type="button"
        aria-label="Close chat"
        onClick={close}
        className="hidden flex-1 bg-on-primary/40 backdrop-blur-sm md:block"
      />
      <aside
        className="ml-auto flex h-full w-full flex-col border-l border-outline-variant/20 bg-surface shadow-2xl md:w-[400px]"
        role="dialog"
        aria-label="Project chat"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low px-3 py-2">
          <div className="flex items-center gap-1">
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
              Chat
            </TabButton>
            <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
              Sessions
            </TabButton>
            {isRunning && (
              <span className="ml-1 text-[10px] font-medium text-info">running</span>
            )}
            <ContextUsageBar usage={usage} />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Link
              href={fullViewHref}
              title="Open in full view"
              className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        {tab === 'sessions' ? (
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-outline-variant/30 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5">
                {desktopConnected ? (
                  <>
                    <Monitor className="h-3.5 w-3.5 text-success" />
                    <span className="text-success">Desktop online</span>
                  </>
                ) : (
                  <>
                    <MonitorOff className="h-3.5 w-3.5 text-on-surface-variant" />
                    <span className="text-on-surface-variant">Desktop offline</span>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={handleNewChat}
                className="flex items-center gap-1 text-primary hover:underline"
              >
                <Plus className="h-3 w-3" />
                New
              </button>
            </div>
            <SessionList
              sessions={sessions}
              loading={loadingSessions}
              activeSessionId={sessionId}
              onSelect={handleSelectSession}
              onNew={handleNewChat}
            />
          </div>
        ) : showDraftEditor ? (
          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-2 text-xs text-on-surface-variant">
              Draft prompt — review and send:
            </p>
            <textarea
              value={editablePrompt}
              onChange={(e) => setEditablePrompt(e.target.value)}
              className="w-full rounded border border-outline-variant/30 bg-surface-container-low p-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              rows={8}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleStartFromDraft}
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-on-primary"
              >
                Send
              </button>
              <button
                type="button"
                onClick={handleCancelDraft}
                className="text-xs text-on-surface-variant hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ChatMessages messages={messages} sessionId={sessionId} />
        )}

        {tab === 'chat' && !showDraftEditor && (
          <div className="pb-[env(safe-area-inset-bottom)]">
            <ChatInput onSend={handleSend} isRunning={isRunning} onStop={abortAgent} />
          </div>
        )}
      </aside>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-surface-container text-on-surface'
          : 'text-on-surface-variant hover:bg-surface-container/60',
      )}
    >
      {children}
    </button>
  );
}
