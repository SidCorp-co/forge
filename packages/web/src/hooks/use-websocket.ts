'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_URL } from '@/lib/api/client';
const MAX_RETRIES = 10;
const BASE_DELAY = 1000;

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryCount = useRef(0);
  const [connected, setConnected] = useState(false);

  const pendingKeys = useRef(new Set<string>());
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const invalidate = useCallback(
    (keys: Array<string | readonly string[]>) => {
      keys.forEach((key) =>
        pendingKeys.current.add(JSON.stringify(Array.isArray(key) ? key : [key])),
      );
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const toInvalidate = [...pendingKeys.current];
        pendingKeys.current.clear();
        toInvalidate.forEach((serialized) =>
          queryClient.invalidateQueries({ queryKey: JSON.parse(serialized) }),
        );
      }, 300);
    },
    [queryClient]
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (retryCount.current >= MAX_RETRIES) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      retryCount.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.event) {
          case 'issue:created':
          case 'issue:updated':
          case 'issue:confirmed':
          case 'issue:enrichment_failed':
          case 'issue:resolved':
            invalidate(['issues', 'issue']);
            break;
          case 'task:created':
          case 'task:updated':
            invalidate(['tasks']);
            break;
          case 'agent:completed':
          case 'agent:failed':
          case 'agent:started':
            invalidate(['tasks']);
            break;
          case 'agent:complete':
            invalidate(['agent-sessions']);
            break;
          case 'notification:created':
            invalidate(['notifications', 'notifications-unread']);
            break;
          case 'ws:error':
            break;
        }
        // Comments are created via lifecycle/enrichment, invalidate on any issue event
        if (msg.event?.startsWith('issue:')) {
          invalidate(['comments']);
        }
        // Per-session relays carry a sessionId in the wrapped payload —
        // invalidate the matching ['agent-session', id] cache so the
        // agent page picks up the persisted diff/status without a manual
        // refetch on the running side.
        if (
          typeof msg.event === 'string' &&
          msg.event.startsWith('agent-session.relay.')
        ) {
          const sessionId = msg.data?.sessionId;
          if (typeof sessionId === 'string' && sessionId) {
            invalidate([['agent-session', sessionId], 'agent-sessions']);
          }
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (retryCount.current < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY * 2 ** retryCount.current, 30_000);
        retryCount.current += 1;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [invalidate]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
