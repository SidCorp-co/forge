'use client';

import { useCallback, useEffect, useRef } from 'react';
import { finalizeAssistantMsg } from '@/lib/agent-stream-utils';
import { useAgentMessageState } from './use-agent-message-state';
import { useAgentWebSocket } from './use-agent-websocket';
import { useAgentSessionApi } from './use-agent-session-api';
import { useAgentPromptBuild } from './use-agent-prompt-build';

interface UseAgentStreamOptions {
  projectSlug: string;
}

export function useAgentStream({ projectSlug }: UseAgentStreamOptions) {
  const state = useAgentMessageState();
  const {
    messages, setMessages, isRunning, setIsRunning,
    sessionId, setSessionId, claudeSessionId, setClaudeSessionId,
    desktopConnected, setDesktopConnected,
    usage, setUsage,
    mountedRef, sessionIdRef, streamingMsgId, streamingTextRef,
    clearStreamState, EMPTY_USAGE,
  } = state;

  const promptBuild = useAgentPromptBuild(projectSlug, clearStreamState);
  const {
    draftPrompt, setDraftPrompt,
    isBuildingPrompt,
    pendingIssueIds, setPendingIssueIds,
    requestBuildPrompt, clearDraftPrompt,
    handlePromptBuilt, handlePreviewPrompt,
  } = promptBuild;

  const { wsRef } = useAgentWebSocket({
    projectSlug,
    sessionIdRef, mountedRef, streamingMsgId, streamingTextRef,
    setMessages, setIsRunning, setSessionId, setClaudeSessionId,
    setDesktopConnected, setUsage,
    setDraftPrompt, setPendingIssueIds,
    handlePromptBuilt, handlePreviewPrompt,
  });

  const finalize = useCallback(() => {
    finalizeAssistantMsg(streamingMsgId, streamingTextRef, setMessages);
  }, [streamingMsgId, streamingTextRef, setMessages]);

  const { startAgent, sendMessage, abortAgent, loadSession, refreshSession } = useAgentSessionApi({
    projectSlug, mountedRef, streamingMsgId, streamingTextRef, wsRef,
    sessionId, claudeSessionId,
    setMessages, setIsRunning, setSessionId, setClaudeSessionId, setUsage,
    finalize,
  });

  // Per-session re-subscribe used to fire here on the legacy sessionId-keyed
  // protocol. Core's WS now broadcasts agent-session.relay.* into the project
  // room, which use-agent-websocket subscribes to once on connect — no need
  // to re-subscribe per session. Filtering by sessionId happens in
  // createAgentMessageHandler.

  // Fallback: poll session and load messages while running
  useEffect(() => {
    if (!isRunning || !sessionId) return;
    const interval = setInterval(() => {
      refreshSession(sessionId);
    }, 15000);
    return () => clearInterval(interval);
  }, [isRunning, sessionId, refreshSession]);

  // When isRunning transitions to false, do one final refresh to catch missed messages
  const prevIsRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = prevIsRunningRef.current;
    prevIsRunningRef.current = isRunning;
    if (wasRunning && !isRunning && sessionId) {
      refreshSession(sessionId);
    }
  }, [isRunning, sessionId, refreshSession]);

  const resetSession = useCallback(() => {
    clearStreamState();
  }, [clearStreamState]);

  return {
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
    requestBuildPrompt,
    clearDraftPrompt,
    usage,
  };
}
