'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { agentApi } from '@/features/agent/api';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { WS_URL } from '@/lib/api/client';
import type { AgentAction } from './use-agent-message-state';
import { createAgentMessageHandler } from './use-agent-ws-handlers';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

interface UseAgentWebSocketOptions {
  projectSlug: string;
  sessionIdRef: React.MutableRefObject<string | null>;
  mountedRef: React.MutableRefObject<boolean>;
  dispatch: React.Dispatch<AgentAction>;
  handlePromptBuilt: (requestId: string, prompt: string | null, error: string | null) => void;
  handlePreviewPrompt: (prompt: string, issueIds: string[] | undefined) => void;
}

export function useAgentWebSocket(opts: UseAgentWebSocketOptions) {
  const { projectSlug, sessionIdRef, mountedRef, dispatch, handlePromptBuilt, handlePreviewPrompt } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  // Mirror connectionState into a ref so reconnectNow can be a stable callback;
  // reading state directly would force the dep, churning prop identity every 2s.
  const connectionStateRef = useRef<ConnectionState>('connecting');
  useEffect(() => { connectionStateRef.current = connectionState; }, [connectionState]);

  // Core's WS protocol expects `{type:'subscribe', room:'project:<uuid>'}`
  // (legacy Strapi shape used `{type:'subscribe', sessionId}` and was silently
  // dropped on the new server). Resolve the project id once so both the
  // initial subscribe and the per-session refresh both target the right room.
  const project = useProjectBySlug(projectSlug);
  const projectIdRef = useRef<string | null>(project?.id ?? null);
  projectIdRef.current = project?.id ?? null;

  useEffect(() => {
    agentApi.desktopStatus({ projectSlug })
      .then((res) => {
        if (mountedRef.current) {
          dispatch({ type: 'desktopConnectedSet', value: res?.data?.connected ?? false });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Closure-scoped lifecycle guard. A ref shared across effect runs would
    // leak state between StrictMode mount-1 and mount-2 — mount-2's reset to
    // `false` lets mount-1's deferred onclose schedule a reconnect against
    // mount-2's live socket.
    let disposed = false;

    const handleMessage = createAgentMessageHandler({
      projectSlug,
      sessionIdRef,
      dispatch,
      handlePromptBuilt,
      handlePreviewPrompt,
    });

    function connect() {
      if (disposed) return;
      // Stay in 'reconnecting' across retry attempts during an outage so the
      // pill doesn't flicker connecting↔reconnecting every 2s. 'connecting'
      // is reserved for the initial mount handshake.
      setConnectionState((prev) => (prev === 'reconnecting' ? prev : 'connecting'));
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        setConnectionState('open');
        const pid = projectIdRef.current;
        if (pid) {
          ws.send(JSON.stringify({ type: 'subscribe', room: `project:${pid}` }));
        }
        agentApi.desktopStatus({ projectSlug })
          .then((res) => {
            if (mountedRef.current) {
              dispatch({ type: 'desktopConnectedSet', value: res?.data?.connected ?? false });
            }
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
        // Only clear the live ref if it still points at *this* socket — a
        // stale post-cleanup onclose firing after a new socket has been
        // assigned would otherwise wipe the live reference.
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          setConnectionState('reconnecting');
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => ws.close();
    }

    connectRef.current = connect;
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      connectRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reconnectNow = useCallback(() => {
    // Disposed effects null `connectRef.current`; the optional-chain at the
    // bottom of this callback is the disposed-guard. No separate flag needed.
    if (connectionStateRef.current === 'open') return;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    // Drop in-flight handshake's listeners before reopening — otherwise the
    // orphan's onopen fires send(subscribe) on a leaked connection.
    const stale = wsRef.current;
    if (stale) {
      wsRef.current = null;
      stale.onopen = null;
      stale.onclose = null;
      stale.onmessage = null;
      stale.onerror = null;
      try { stale.close(); } catch { /* ignore */ }
    }
    connectRef.current?.();
  }, []);

  return { connectionState, reconnectNow };
}
