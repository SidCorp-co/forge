# WebSocket Implementation Guide

Reference documentation for rebuilding the WebSocket real-time layer in another project.

## Overview

A dual-purpose WebSocket system:
1. **Broadcast** — push data-change events to ALL clients for cache invalidation
2. **Session-targeted** — stream AI agent/chat responses to subscribed clients only

Single WebSocket endpoint at `/ws`. No authentication on the WS connection itself — it's a notification channel, not a data channel.

---

## Server Side

### Tech Stack
- `ws` (npm) WebSocketServer, attached to the existing HTTP server
- No separate WS port — shares the main HTTP server

### Setup

```ts
import { WebSocketServer, WebSocket } from 'ws';

let wss: WebSocketServer | null = null;
const sessionSubscriptions = new Map<string, Set<WebSocket>>();

export function initWebSocket(httpServer: any) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.sessionId) {
          let subs = sessionSubscriptions.get(msg.sessionId);
          if (!subs) {
            subs = new Set();
            sessionSubscriptions.set(msg.sessionId, subs);
          }
          subs.add(ws);
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          sessionSubscriptions.get(msg.sessionId)?.delete(ws);
        }
      } catch { /* ignore non-JSON */ }
    });

    ws.on('close', () => {
      for (const subs of sessionSubscriptions.values()) {
        subs.delete(ws);
      }
    });

    ws.on('error', (err) => console.error('WS client error:', err));
  });
}
```

Call `initWebSocket(httpServer)` during server bootstrap.

### Server API Functions

#### `broadcast(event, data)`
Send to ALL connected clients. Used for data-change notifications.

```ts
export function broadcast(event: string, data: unknown) {
  if (!wss) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
```

#### `sendToSession(sessionId, event, data)`
Send only to clients subscribed to a specific session. Used for AI streaming.

```ts
export function sendToSession(sessionId: string, event: string, data: unknown) {
  const subs = sessionSubscriptions.get(sessionId);
  if (!subs || subs.size === 0) return false;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  let sent = 0;
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
    }
  }
  return sent > 0;
}
```

#### `waitForSubscriber(sessionId, timeoutMs)`
Poll until at least one client subscribes. Prevents race conditions where the server starts streaming before the client has subscribed.

```ts
export function waitForSubscriber(sessionId: string, timeoutMs = 5000): Promise<boolean> {
  const subs = sessionSubscriptions.get(sessionId);
  if (subs && subs.size > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const interval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += interval;
      const s = sessionSubscriptions.get(sessionId);
      if (s && s.size > 0) {
        clearInterval(timer);
        resolve(true);
      } else if (elapsed >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });
}
```

### Wire Format

All messages are JSON with a consistent envelope:

```json
{
  "event": "issue:created",
  "data": { "documentId": "abc123", "title": "Bug report" },
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Client-to-Server Messages

| Message | Purpose |
|---------|---------|
| `{ "type": "subscribe", "sessionId": "..." }` | Join a session channel |
| `{ "type": "unsubscribe", "sessionId": "..." }` | Leave a session channel |

### Triggering Broadcasts

Call `broadcast()` from lifecycle hooks / service logic whenever data changes:

```ts
// In an issue lifecycle hook (after create)
broadcast('issue:created', { documentId: result.documentId, title: result.title });

// In a task lifecycle hook (after update)
broadcast('task:updated', { documentId: result.documentId, status: result.status });

// In AI enrichment service
broadcast('issue:updated', { documentId: issueDocumentId });
```

### Triggering Session Events

Call `sendToSession()` during AI agent/chat execution to stream responses:

```ts
// When a new chat session is ready
broadcast('chat:session_ready', { sessionId, requestId });

// During AI streaming — text chunks
sendToSession(sessionId, 'chat:text_delta', { text: chunk });

// Tool usage
sendToSession(sessionId, 'chat:tool_use', { id: toolId, name: toolName });

// Per-iteration done (tool calls finished, more iterations may follow)
sendToSession(sessionId, 'chat:done', { usage });

// Full run complete
sendToSession(sessionId, 'chat:complete', { sessionId, reply: fullText });

// Error
sendToSession(sessionId, 'chat:error', { error: errorMessage });
```

---

## Client Side (React)

### Tech Stack
- Native browser `WebSocket` API
- React hooks with `useRef` / `useState`
- `@tanstack/react-query` for cache invalidation

### WS URL Configuration

```ts
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
const API_ORIGIN = API_URL.replace(/\/api\/?$/, '');

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  API_ORIGIN.replace(/^http/, 'ws') + '/ws';
// http://localhost:8080 -> ws://localhost:8080/ws
```

### Hook 1: `useWebSocket()` — Global Cache Invalidation

Connects once at app level. Listens for broadcast events and invalidates React Query caches.

```ts
import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const MAX_RETRIES = 10;
const BASE_DELAY = 1000;

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryCount = useRef(0);
  const [connected, setConnected] = useState(false);

  const invalidate = useCallback(
    (keys: string[]) => {
      keys.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [key], refetchType: 'all' })
      );
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
            invalidate(['issues', 'issue']);
            break;
          case 'task:created':
          case 'task:updated':
            invalidate(['tasks']);
            break;
          case 'notification:created':
            invalidate(['notifications']);
            break;
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      if (retryCount.current < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY * 2 ** retryCount.current, 30_000);
        retryCount.current += 1;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => ws.close();
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
```

**Key pattern:** Exponential backoff reconnect (1s, 2s, 4s, ... up to 30s, max 10 retries).

### Hook 2: `useChatWebSocket()` — AI Chat Streaming

Subscribes to a session and assembles streaming messages from text deltas, tool calls, and completion events.

```ts
import { useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  toolCalls?: ToolCallData[];
}

interface ToolCallData {
  id: string;
  name: string;
  isStreaming: boolean;
  result?: string;
  isError?: boolean;
}

interface UseChatWebSocketOptions {
  sessionId: string | null;
  setSessionId?: (id: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
}

export function useChatWebSocket({ sessionId, setSessionId, setMessages }: UseChatWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const streamingMsgId = useRef<string | null>(null);
  const pendingRequestId = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const mountedRef = useRef(true);

  const subscribeToSession = useCallback((sid: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
    }
  }, []);

  const unsubscribeFromSession = useCallback((sid: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', sessionId: sid }));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        const sid = sessionIdRef.current;
        if (sid) subscribeToSession(sid);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const msgId = streamingMsgId.current;

          // Subscribe to new session before streaming starts
          if (msg.event === 'chat:session_ready' && msg.data?.requestId === pendingRequestId.current) {
            const sid = msg.data.sessionId;
            pendingRequestId.current = null;
            subscribeToSession(sid);
            setSessionId?.(sid);
          }

          // Append text chunk to streaming message
          if (msg.event === 'chat:text_delta' && msgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, content: m.content + (msg.data?.text || '') } : m
              )
            );
          }

          // Add tool call to streaming message
          else if (msg.event === 'chat:tool_use' && msgId) {
            const toolCall: ToolCallData = {
              id: msg.data?.id || crypto.randomUUID(),
              name: msg.data?.name || 'tool',
              isStreaming: true,
            };
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] }
                  : m
              )
            );
          }

          // Per-iteration done — mark tool calls finished, keep streaming
          else if (msg.event === 'chat:done' && msgId) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== msgId) return m;
                return { ...m, toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })) };
              })
            );
          }

          // Full run complete — finalize message
          else if (msg.event === 'chat:complete') {
            const reply = msg.data?.reply || '';
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === msgId || (m.isStreaming && m.role === 'assistant')) {
                  return { ...m, content: reply || m.content, isStreaming: false,
                    toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })) };
                }
                return m;
              })
            );
            streamingMsgId.current = null;
          }

          // Error — finalize with error message
          else if (msg.event === 'chat:error' && msgId) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== msgId) return m;
                return { ...m, content: m.content || 'An error occurred.', isStreaming: false };
              })
            );
            streamingMsgId.current = null;
          }
        } catch {}
      };

      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (mountedRef.current) reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  // Re-subscribe when sessionId changes
  useEffect(() => {
    if (sessionId) subscribeToSession(sessionId);
    return () => { if (sessionId) unsubscribeFromSession(sessionId); };
  }, [sessionId, subscribeToSession, unsubscribeFromSession]);

  return { wsRef, streamingMsgId, pendingRequestId, subscribeToSession };
}
```

### Hook 3: `useAgentRunLog()` — Lightweight Progress Log

Simple log-only stream for inline progress indicators (no full chat UI).

```ts
import { useState, useEffect, useRef, useCallback } from 'react';

export function useAgentRunLog() {
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const startRun = useCallback((sessionId: string, label: string) => {
    sessionIdRef.current = sessionId;
    setStatus(label);
    setLog([]);
    setIsRunning(true);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        const sid = sessionIdRef.current;
        if (sid) ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!sessionIdRef.current) return;
          if (msg.data?.sessionId && msg.data.sessionId !== sessionIdRef.current) return;

          if (msg.event === 'agent:message') {
            const content = msg.data?.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  setLog((prev) => [...prev, block.text]);
                } else if (block.type === 'tool_use') {
                  setLog((prev) => [...prev, `Tool: ${block.name}`]);
                }
              }
            }
          } else if (msg.event === 'agent:complete') {
            setStatus('Complete');
            setIsRunning(false);
            sessionIdRef.current = null;
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  return { status, log, isRunning, startRun };
}
```

### Polling Fallback

If the WebSocket drops mid-stream, poll the session status as a safety net:

```ts
useEffect(() => {
  if (!isRunning || !sessionId) return;
  const interval = setInterval(async () => {
    try {
      const res = await api.getSession(sessionId);
      if (res.data?.status !== 'running') {
        finalize();
        setIsRunning(false);
      }
    } catch {}
  }, 15000);
  return () => clearInterval(interval);
}, [isRunning, sessionId]);
```

---

## Event Catalog

### Broadcast Events (all clients)

| Event | Trigger | Typical Client Action |
|-------|---------|----------------------|
| `issue:created` | Issue lifecycle afterCreate | Invalidate `['issues']` |
| `issue:updated` | Issue lifecycle afterUpdate, AI enrichment | Invalidate `['issues', 'issue']` |
| `issue:confirmed` | Issue status changed to confirmed | Invalidate `['issues', 'issue']` |
| `issue:resolved` | Issue resolution service | Invalidate `['issues', 'issue']` |
| `issue:enrichment_failed` | AI enrichment error | Invalidate `['issues']` |
| `task:created` | Task lifecycle afterCreate | Invalidate `['tasks']` |
| `task:updated` | Task lifecycle afterUpdate | Invalidate `['tasks']` |
| `agent:completed` | Agent task finished | Invalidate `['tasks']` |
| `notification:created` | Notification lifecycle | Invalidate `['notifications']` |

### Session Events (subscribed clients only)

| Event | Data | Purpose |
|-------|------|---------|
| `chat:session_ready` | `{ sessionId, requestId }` | Client subscribes to new session |
| `chat:text_delta` | `{ text }` | Append text chunk to streaming message |
| `chat:tool_use` | `{ id, name }` | Show tool call in progress |
| `chat:done` | `{ usage }` | Per-iteration complete (may have more) |
| `chat:complete` | `{ sessionId, reply }` | Full run finished, finalize message |
| `chat:error` | `{ error }` | Run failed, show error |
| `agent:message` | `{ sessionId, type, message }` | Full message block from agent |
| `agent:complete` | `{ sessionId }` | Agent run finished |
| `agent:user-message` | `{ sessionId, content }` | Echo user message to subscribers |

---

## Architecture Diagram

```
                        Client A (browser)              Client B (browser)
                            |                               |
                     useWebSocket()                  useChatWebSocket()
                    (broadcast listener)           (session subscriber)
                            |                               |
                            +----------- WSS ---------------+
                                          |
                                    /ws endpoint
                                   WebSocketServer
                                          |
                          +---------------+----------------+
                          |               |                |
                    broadcast()    sendToSession()   waitForSubscriber()
                          |               |                |
                  Lifecycle hooks    Chat controller   Pre-stream sync
                  (issue, task,     (AI streaming)
                   notification)
```

## Key Design Decisions

1. **No auth on WS** — The WebSocket is a notification channel. Sensitive data is fetched via authenticated REST API calls triggered by cache invalidation.

2. **Broadcast + Session dual model** — Broadcasts are cheap fire-and-forget for cache busting. Session channels are for streaming large payloads to specific clients.

3. **React Query integration** — WS events trigger `invalidateQueries()` rather than manually updating state. This keeps the source of truth in the API and avoids stale data.

4. **Text delta streaming** — AI responses are streamed as small text chunks (`chat:text_delta`) and assembled client-side by appending to message content.

5. **Multi-iteration awareness** — `chat:done` fires per AI iteration (after tool calls), `chat:complete` fires once when the full run ends. This allows the UI to show intermediate progress.

6. **Polling fallback** — A 15s polling interval catches completion if the WebSocket drops mid-stream.

7. **`waitForSubscriber()`** — Server-side race condition prevention. Ensures a client is listening before streaming begins.

8. **Reconnect strategies** — Exponential backoff (1s-30s, 10 max) for the global hook; fixed 2s delay for session hooks (simpler, session-scoped).
