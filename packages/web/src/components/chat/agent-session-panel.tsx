'use client';

import { useEffect, useCallback } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { ChatMessages } from './chat-messages';
import { ChatInput } from './chat-input';
import { ContextUsageBar } from './context-usage-bar';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { uploadAndFormatMessage } from '@/lib/utils/upload-files';

interface AgentSessionPanelProps {
  sessionId: string;
  projectSlug: string;
  onClose: () => void;
  onOpenFull?: () => void;
}

export function AgentSessionPanel({ sessionId: targetSessionId, projectSlug, onClose, onOpenFull }: AgentSessionPanelProps) {
  const {
    messages,
    isRunning,
    sessionId,
    sendMessage,
    abortAgent,
    loadSession,
    startAgent,
    usage,
  } = useAgentStreamContext();

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
        <div className="flex items-center gap-1 shrink-0">
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

      {/* Messages */}
      <ChatMessages messages={messages} />

      {/* Input */}
      <ChatInput
        onSend={(text, files) => handleSend(text, files)}
        isRunning={isRunning}
        onStop={abortAgent}
      />
    </div>
  );
}
