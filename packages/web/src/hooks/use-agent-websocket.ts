'use client';

import { useRef, useEffect } from 'react';
import type { ChatMessageData } from '@/components/message-bubble/chat-message';
import { agentApi } from '@/features/agent/api';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { WS_URL } from '@/lib/api/client';
import { createAgentMessageHandler } from './use-agent-ws-handlers';

interface UseAgentWebSocketOptions {
  projectSlug: string;
  sessionIdRef: React.MutableRefObject<string | null>;
  mountedRef: React.MutableRefObject<boolean>;
  streamingMsgId: React.MutableRefObject<string | null>;
  streamingTextRef: React.MutableRefObject<string>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setClaudeSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setDesktopConnected: React.Dispatch<React.SetStateAction<boolean>>;
  setUsage: React.Dispatch<React.SetStateAction<import('@/features/agent/api').AgentUsage>>;
  setDraftPrompt: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingIssueIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  handlePromptBuilt: (requestId: string, prompt: string | null, error: string | null) => void;
  handlePreviewPrompt: (prompt: string, issueIds: string[] | undefined) => void;
}

export function useAgentWebSocket(opts: UseAgentWebSocketOptions) {
  const {
    projectSlug,
    sessionIdRef, mountedRef, streamingMsgId, streamingTextRef,
    setMessages, setIsRunning, setSessionId, setClaudeSessionId,
    setDesktopConnected, setUsage,
    handlePromptBuilt, handlePreviewPrompt,
  } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Core's WS protocol expects `{type:'subscribe', room:'project:<uuid>'}`
  // (legacy Strapi shape used `{type:'subscribe', sessionId}` and was silently
  // dropped on the new server). Resolve the project id once so both the
  // initial subscribe and the per-session refresh both target the right room.
  const project = useProjectBySlug(projectSlug);
  const projectIdRef = useRef<string | null>(project?.id ?? null);
  projectIdRef.current = project?.id ?? null;

  // Check desktop status on mount
  useEffect(() => {
    agentApi.desktopStatus({ projectSlug })
      .then((res) => {
        if (mountedRef.current) setDesktopConnected(res?.data?.connected ?? false);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket with auto-reconnect
  useEffect(() => {
    let disposed = false;

    const handleMessage = createAgentMessageHandler({
      projectSlug,
      sessionIdRef,
      streamingMsgId,
      streamingTextRef,
      setMessages,
      setIsRunning,
      setSessionId,
      setClaudeSessionId,
      setDesktopConnected,
      setUsage,
      handlePromptBuilt,
      handlePreviewPrompt,
    });

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        const pid = projectIdRef.current;
        if (pid) {
          ws.send(JSON.stringify({ type: 'subscribe', room: `project:${pid}` }));
        }
        agentApi.desktopStatus({ projectSlug })
          .then((res) => {
            if (mountedRef.current) setDesktopConnected(res?.data?.connected ?? false);
          })
          .catch(() => {});
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) {
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { wsRef };
}
