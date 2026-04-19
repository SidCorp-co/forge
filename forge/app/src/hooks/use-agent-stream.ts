import { useState, useRef, useCallback, useEffect } from 'react';
import { agentApi } from '@/features/agent/api';
import { WS_URL } from '@/lib/constants';
import type { ChatMessageData, ToolCallData } from './agent-stream-types';
import { generateId } from './agent-stream-types';

export type { ChatMessageData, ToolCallData } from './agent-stream-types';
export { generateId } from './agent-stream-types';

interface UseAgentStreamOptions {
  projectSlug: string;
}

export function useAgentStream({ projectSlug }: UseAgentStreamOptions) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [desktopConnected, setDesktopConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const streamingMsgId = useRef<string | null>(null);
  const fullTextRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    agentApi.desktopStatus()
      .then((res) => { if (mountedRef.current) setDesktopConnected(res?.data?.connected ?? false); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function connectWs() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectCount.current = 0;
        if (sessionIdRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: sessionIdRef.current }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === 'desktop:connected') { setDesktopConnected(true); return; }
          if (msg.event === 'desktop:disconnected') { setDesktopConnected(false); return; }
          if (msg.data?.sessionId && msg.data.sessionId !== sessionIdRef.current) return;

          const msgId = streamingMsgId.current;
          if (msg.event === 'agent:message' && msgId) {
            handleAgentMessage(msg.data, msgId);
          } else if (msg.event === 'agent:complete') {
            handleAgentComplete(msg.data, msgId);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        const delay = Math.min(1000 * 2 ** reconnectCount.current, 30_000);
        reconnectCount.current += 1;
        if (reconnectCount.current <= 10) {
          reconnectTimer.current = setTimeout(() => {
            if (mountedRef.current) connectWs();
          }, delay);
        }
      };

      ws.onerror = () => ws.close();
    }

    connectWs();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && sessionId) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    }
  }, [sessionId]);

  function handleAgentMessage(d: Record<string, any>, msgId: string) {
    if (d.type === 'assistant' && d.message?.type === 'text') {
      fullTextRef.current += d.message.content || '';
      setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: fullTextRef.current } : m));
    } else if (d.type === 'assistant' && d.message?.type === 'tool_use') {
      const tc: ToolCallData = { id: d.message.id || generateId(), name: d.message.name || 'tool', input: d.message.input, isStreaming: true };
      setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m));
    } else if (d.type === 'assistant' && d.message?.type === 'tool_result') {
      const toolId = d.message.tool_use_id;
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        return { ...m, toolCalls: m.toolCalls?.map((tc) => tc.id === toolId ? { ...tc, result: d.message.content, isStreaming: false, isError: d.message.is_error } : tc) };
      }));
    }
  }

  function handleAgentComplete(data: Record<string, unknown> | undefined, msgId: string | null) {
    if (data?.claudeSessionId) setClaudeSessionId(data.claudeSessionId as string);
    if (msgId) {
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        return { ...m, isStreaming: false, toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })) };
      }));
    }
    streamingMsgId.current = null;
    fullTextRef.current = '';
    setIsRunning(false);
  }

  const createMsgPair = (content: string) => {
    const userMsg: ChatMessageData = { id: generateId(), role: 'user', content, timestamp: Date.now() };
    const aId = generateId();
    const assistantMsg: ChatMessageData = { id: aId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true };
    streamingMsgId.current = aId;
    fullTextRef.current = '';
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsRunning(true);
    return aId;
  };

  const handleError = (aId: string, err: unknown, label: string) => {
    if (!mountedRef.current) return;
    setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, content: `Error: ${err instanceof Error ? err.message : label}`, isStreaming: false } : m));
    streamingMsgId.current = null;
    setIsRunning(false);
  };

  const startAgent = useCallback(async (prompt: string) => {
    const aId = createMsgPair(prompt);
    try {
      const res = await agentApi.start(projectSlug, prompt);
      if (!mountedRef.current) return;
      const sid = res.data.documentId;
      setSessionId(sid);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
    } catch (err) { handleError(aId, err, 'Failed to start agent'); }
  }, [projectSlug]);

  const sendMessage = useCallback(async (message: string) => {
    if (!sessionId) return;
    const aId = createMsgPair(message);
    try {
      await agentApi.send(sessionId, message, claudeSessionId || undefined);
    } catch (err) { handleError(aId, err, 'Failed to send message'); }
  }, [sessionId, claudeSessionId]);

  const abortAgent = useCallback(async () => {
    if (!sessionId) return;
    try { await agentApi.abort(sessionId); } catch { /* ignore */ }
    setIsRunning(false);
    if (streamingMsgId.current) {
      setMessages((prev) => prev.map((m) => m.id === streamingMsgId.current ? { ...m, isStreaming: false, content: m.content || '(aborted)' } : m));
      streamingMsgId.current = null;
    }
  }, [sessionId]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await agentApi.getSession(id);
      if (!mountedRef.current) return;
      const session = res.data;
      setSessionId(session.documentId);
      setClaudeSessionId(session.claudeSessionId || null);
      setIsRunning(session.status === 'running');
      const loaded: ChatMessageData[] = ((session.messages || []) as Record<string, unknown>[])
        .map((m, i) => ({ id: `stored-${i}`, role: m.role as 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : '', timestamp: (m.timestamp as number) || Date.now(), toolCalls: m.toolCalls as ToolCallData[] | undefined }))
        .filter((m) => m.content || m.toolCalls?.length);
      setMessages(loaded);
    } catch { /* ignore */ }
  }, []);

  const resetSession = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setClaudeSessionId(null);
    setIsRunning(false);
    streamingMsgId.current = null;
    fullTextRef.current = '';
  }, []);

  return { messages, isRunning, sessionId, desktopConnected, startAgent, sendMessage, abortAgent, loadSession, resetSession };
}
