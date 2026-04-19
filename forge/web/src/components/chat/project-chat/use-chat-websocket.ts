'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_URL } from '@/lib/api/client';
import type { ChatMessageData, ContentBlock, ToolCallData } from '../chat-message';

interface UseChatWebSocketOptions {
  sessionId: string | null;
  setSessionId?: (id: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
}

export function useChatWebSocket({ sessionId, setSessionId, setMessages }: UseChatWebSocketOptions) {
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const setSessionIdRef = useRef(setSessionId);
  setSessionIdRef.current = setSessionId;
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

  // Finalize a streaming message (mark isStreaming: false)
  const finalizeMessage = useCallback((msgId: string, reply?: string) => {
    setMessagesRef.current((prev) =>
      prev.map((m) => {
        if (m.id !== msgId && !(m.isStreaming && m.role === 'assistant')) return m;
        if (m.id === msgId || m.isStreaming) {
          return {
            ...m,
            content: m.content || reply || '',
            isStreaming: false,
            toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })),
          };
        }
        return m;
      })
    );
  }, []);

  // Connect to WebSocket with auto-reconnect
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

          // Invalidate board/list queries on data-change broadcasts
          if (msg.event?.startsWith('issue:') || msg.event?.startsWith('task:') || msg.event?.startsWith('agent:')) {
            const qc = queryClientRef.current;
            const keys = msg.event.startsWith('task:') || msg.event.startsWith('agent:')
              ? ['tasks']
              : ['issues', 'issue', 'comments'];
            keys.forEach((k) => qc.invalidateQueries({ queryKey: [k], refetchType: 'all' }));
          }

          // Handle session ready — subscribe to new session before streaming starts
          if (msg.event === 'chat:session_ready' && msg.data?.requestId && msg.data.requestId === pendingRequestId.current) {
            const sid = msg.data.sessionId;
            pendingRequestId.current = null;
            subscribeToSession(sid);
            setSessionIdRef.current?.(sid);
          }

          const msgId = streamingMsgId.current;

          if (msg.event === 'chat:text_delta') {
            if (!msgId) return;
            setMessagesRef.current((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, content: m.content + (msg.data?.text || '') } : m
              )
            );
          } else if (msg.event === 'chat:tool_use') {
            if (!msgId) return;
            const toolCall: ToolCallData = {
              id: msg.data?.id || crypto.randomUUID(),
              name: msg.data?.name || 'tool',
              isStreaming: true,
            };
            setMessagesRef.current((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] }
                  : m
              )
            );
          } else if (msg.event === 'chat:todo_write') {
            if (!msgId) return;
            const todos = (msg.data?.input?.todos as { content: string; status: string; activeForm?: string }[]) ?? [];
            if (todos.length) {
              const todosBlock: ContentBlock = {
                type: 'todos',
                todos: todos.map((t: { content: string; status: string; activeForm?: string }) => ({
                  content: t.content,
                  status: (t.status as 'pending' | 'in_progress' | 'completed') ?? 'pending',
                  activeForm: t.activeForm,
                })),
              };
              setMessagesRef.current((prev) =>
                prev.map((m) => {
                  if (m.id !== msgId) return m;
                  const blocks = [...(m.contentBlocks || [])];
                  const existingIdx = blocks.findIndex((b) => b.type === 'todos');
                  if (existingIdx >= 0) {
                    blocks[existingIdx] = todosBlock;
                  } else {
                    blocks.push(todosBlock);
                  }
                  return { ...m, contentBlocks: blocks };
                })
              );
            }
          } else if (msg.event === 'chat:done') {
            // message_end fires per iteration — don't finalize here.
            // Mark current tool calls as done but keep streaming for next iteration.
            if (msgId) {
              setMessagesRef.current((prev) =>
                prev.map((m) => {
                  if (m.id !== msgId) return m;
                  const updatedTools = m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false }));
                  return { ...m, toolCalls: updatedTools };
                })
              );
            }
          } else if (msg.event === 'chat:complete') {
            // Fires once after the full agent run — finalize the message with full reply.
            // May arrive via session subscription OR broadcast; match by msgId or sessionId.
            const matchesSession = msg.data?.sessionId && msg.data.sessionId === sessionIdRef.current;
            if (!msgId && !matchesSession) return;

            const reply = msg.data?.reply || '';
            setMessagesRef.current((prev) =>
              prev.map((m) => {
                if (m.id === msgId || (m.isStreaming && m.role === 'assistant')) {
                  return {
                    ...m,
                    content: reply || m.content || '',
                    isStreaming: false,
                    toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })),
                  };
                }
                return m;
              })
            );
            streamingMsgId.current = null;
          } else if (msg.event === 'chat:error') {
            if (msgId) {
              setMessagesRef.current((prev) =>
                prev.map((m) => {
                  if (m.id !== msgId) return m;
                  return {
                    ...m,
                    content: m.content || 'An error occurred. Please try again.',
                    isStreaming: false,
                    toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })),
                  };
                })
              );
              streamingMsgId.current = null;
            }
          }
        } catch { /* ignore */ }
      };

      ws.onerror = () => ws.close();

      ws.onclose = () => {
        // Auto-reconnect after 2s if still mounted
        if (mountedRef.current) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe when sessionId changes
  useEffect(() => {
    if (sessionId) subscribeToSession(sessionId);
    return () => {
      if (sessionId) unsubscribeFromSession(sessionId);
    };
  }, [sessionId, subscribeToSession, unsubscribeFromSession]);

  return { wsRef, streamingMsgId, pendingRequestId, subscribeToSession };
}
