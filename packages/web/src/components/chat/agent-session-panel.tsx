'use client';

import { useEffect, useCallback, useState } from 'react';
import { X, ExternalLink, MoreVertical, GitBranch, RotateCcw, Pin, PinOff } from 'lucide-react';
import { ChatMessages } from './chat-messages';
import { ChatInput } from './chat-input';
import { ContextUsageBar } from './context-usage-bar';
import { SessionPlaceholder } from './session-placeholder';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { uploadAndFormatMessage } from '@/lib/utils/upload-files';
import { agentApi } from '@/features/agent/api';

interface AgentSessionPanelProps {
  sessionId: string;
  projectSlug: string;
  onClose: () => void;
  onOpenFull?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}

export function AgentSessionPanel({
  sessionId: targetSessionId,
  projectSlug,
  onClose,
  onOpenFull,
  pinned,
  onTogglePin,
}: AgentSessionPanelProps) {
  const {
    messages,
    isRunning,
    sessionId,
    sendMessage,
    abortAgent,
    loadSession,
    startAgent,
    usage,
    forkSession,
    rerunSession,
  } = useAgentStreamContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);

  // Load the target session on mount (if not already loaded)
  useEffect(() => {
    if (targetSessionId && sessionId !== targetSessionId) {
      loadSession(targetSessionId);
    }
  }, [targetSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(async (text: string, files?: File[]) => {
    if (!text.trim() && (!files || files.length === 0)) return;
    const messageText = await uploadAndFormatMessage(text, files);
    if (sessionId) {
      sendMessage(messageText);
    } else {
      startAgent(messageText);
    }
  }, [sessionId, sendMessage, startAgent]);

  const sessionTitle = messages.length > 0
    ? (messages.find((m) => m.role === 'user')?.content.slice(0, 60) || 'Agent Session')
    : 'Agent Session';

  const lastTurnIdWithId = [...messages].reverse().find((m) => m.turnId)?.turnId ?? null;

  async function handleRerun() {
    setMenuError(null);
    try {
      const newId = await rerunSession();
      setMenuOpen(false);
      if (newId && typeof window !== 'undefined') {
        window.location.href = `${window.location.pathname}?session=${newId}`;
      }
    } catch (err) {
      setMenuError(err instanceof Error ? err.message : 'Rerun failed');
    }
  }

  async function handleForkFromCurrent() {
    if (!lastTurnIdWithId) return;
    setMenuError(null);
    try {
      const newId = await forkSession(lastTurnIdWithId);
      setMenuOpen(false);
      if (newId && typeof window !== 'undefined') {
        window.location.href = `${window.location.pathname}?session=${newId}`;
      }
    } catch (err) {
      setMenuError(err instanceof Error ? err.message : 'Fork failed');
    }
  }

  const reload = useCallback(async () => {
    if (sessionId) await loadSession(sessionId);
  }, [sessionId, loadSession]);

  const handleAfterFork = useCallback((newId: string) => {
    if (typeof window !== 'undefined') {
      window.location.href = `${window.location.pathname}?session=${newId}`;
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-surface chat-prose">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-on-surface truncate" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>{sessionTitle}</h3>
          {isRunning && (
            <span className="shrink-0 text-[10px] font-medium text-info">running</span>
          )}
          <ContextUsageBar usage={usage} />
        </div>
        <div className="relative flex items-center gap-1 shrink-0">
          {sessionId && (
            <>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="rounded p-1.5 text-on-surface-variant hover:text-on-surface-variant"
                title="Session actions"
                aria-label="Session actions"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded border border-outline-variant/30 bg-surface-container shadow-md">
                  <button
                    onClick={handleRerun}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-on-surface hover:bg-surface-container-high"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Rerun
                  </button>
                  <button
                    onClick={handleForkFromCurrent}
                    disabled={!lastTurnIdWithId}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Fork from current
                  </button>
                  {menuError && (
                    <div className="border-t border-outline-variant/30 px-3 py-2 text-xs text-error">
                      {menuError}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {onTogglePin && (
            <button
              onClick={onTogglePin}
              className="rounded p-1.5 text-on-surface-variant hover:text-on-surface-variant"
              title={pinned ? 'Unpin — collapse back to peek drawer' : 'Pin — switch to side-by-side split'}
              aria-pressed={pinned ?? false}
              aria-label={pinned ? 'Unpin agent session' : 'Pin agent session'}
            >
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
          )}
          {onOpenFull && (
            <button
              onClick={onOpenFull}
              className="rounded p-1.5 text-on-surface-variant hover:text-on-surface-variant"
              title="Open in full view"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1.5 text-on-surface-variant hover:text-on-surface-variant"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Pipeline placeholder when a target session has no messages yet. */}
      {messages.length === 0 && targetSessionId ? (
        <SessionPlaceholder
          sessionId={targetSessionId}
          onRetry={async () => {
            try {
              await agentApi.retrySession(targetSessionId);
            } catch (err) {
              console.error('retry failed', err);
            }
          }}
          onCancel={async () => {
            try {
              await agentApi.cancelSession(targetSessionId);
            } catch (err) {
              console.error('cancel failed', err);
            }
          }}
        />
      ) : (
        <ChatMessages
          messages={messages}
          sessionId={sessionId}
          onAfterEdit={reload}
          onAfterRegenerate={reload}
          onAfterFork={handleAfterFork}
        />
      )}

      {/* Input */}
      <ChatInput
        onSend={(text, files) => handleSend(text, files)}
        isRunning={isRunning}
        onStop={abortAgent}
      />
    </div>
  );
}
