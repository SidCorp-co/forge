'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAgentMessageState } from './use-agent-message-state';
import { useAgentWebSocket } from './use-agent-websocket';
import { useAgentSessionApi } from './use-agent-session-api';
import { useAgentPromptBuild } from './use-agent-prompt-build';

interface UseAgentStreamOptions {
  projectSlug: string;
}

export function useAgentStream({ projectSlug }: UseAgentStreamOptions) {
  const { state, dispatch, mountedRef, sessionIdRef } = useAgentMessageState();
  const { messages, isRunning, sessionId, claudeSessionId, desktopConnected, usage } = state;

  // Mirror messages into a ref so async callbacks (refreshSession poll) can
  // read the current value without re-creating themselves on every render.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const resetSession = useCallback(() => {
    sessionIdRef.current = null;
    dispatch({ type: 'reset' });
  }, [dispatch, sessionIdRef]);

  const promptBuild = useAgentPromptBuild(projectSlug, resetSession);
  const {
    draftPrompt,
    isBuildingPrompt,
    pendingIssueIds,
    requestBuildPrompt,
    clearDraftPrompt,
    handlePromptBuilt,
    handlePreviewPrompt,
  } = promptBuild;

  // refreshSession comes from useAgentSessionApi below, so we route through a
  // ref to break the forward reference and keep handleReconnect's identity stable.
  const refreshSessionRef = useRef<((id: string) => Promise<void>) | null>(null);
  const handleReconnect = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    refreshSessionRef.current?.(id);
  }, [sessionIdRef]);

  const { connectionState, reconnectNow } = useAgentWebSocket({
    projectSlug,
    sessionIdRef,
    mountedRef,
    dispatch,
    handlePromptBuilt,
    handlePreviewPrompt,
    onReconnect: handleReconnect,
  });

  const {
    startAgent,
    sendMessage,
    abortAgent,
    loadSession,
    refreshSession,
    editTurn,
    regenerateTurn,
    forkSession,
    rerunSession,
  } = useAgentSessionApi({
    projectSlug,
    mountedRef,
    sessionId,
    claudeSessionId,
    messagesRef,
    dispatch,
  });

  useEffect(() => {
    refreshSessionRef.current = refreshSession;
  }, [refreshSession]);

  // Fallback: poll session and load messages while running. WS delivers the
  // terminal frame and the per-session react-query invalidation in
  // use-websocket.ts reconciles the persisted row, so no separate
  // "final refresh" is needed when isRunning flips to false.
  useEffect(() => {
    if (!isRunning || !sessionId) return;
    const interval = setInterval(() => {
      refreshSession(sessionId);
    }, 15000);
    return () => clearInterval(interval);
  }, [isRunning, sessionId, refreshSession]);

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
    editTurn,
    regenerateTurn,
    forkSession,
    rerunSession,
    connectionState,
    reconnectNow,
  };
}
