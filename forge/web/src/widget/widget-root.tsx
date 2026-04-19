import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatMessages } from '@/components/chat/chat-messages';
import { ChatInput } from '@/components/chat/chat-input';
import type { ChatMessageData, ToolCallData } from '@/components/chat/chat-message/chat-message-types';
import type { WidgetConfig } from './types';
import { WidgetAPI, type WidgetSession } from './widget-api';

const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 600;
const STORAGE_KEY = 'forge_widget_sessions';

type View = 'sessions' | 'chat';

function getSavedSessionIds(apiKey: string): string[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return data[apiKey] || [];
  } catch { return []; }
}

function saveSessionId(apiKey: string, sessionId: string) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const ids: string[] = data[apiKey] || [];
    if (!ids.includes(sessionId)) {
      ids.unshift(sessionId);
      data[apiKey] = ids.slice(0, 50);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch { /* ignore */ }
}

export function WidgetRoot({ config }: { config: WidgetConfig }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('sessions');
  const [sessions, setSessions] = useState<WidgetSession[]>([]);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionTitle, setSessionTitle] = useState('');

  const apiRef = useRef(new WidgetAPI(config.apiUrl, config.apiKey));
  const wsRef = useRef<WebSocket | null>(null);
  const streamingMsgId = useRef<string | null>(null);
  const pendingRequestId = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const primaryColor = config.theme?.primaryColor || '#6366f1';
  const isRight = config.position !== 'bottom-left';

  // Load sessions when panel opens
  // If hubToken present: server scopes by user identity
  // Otherwise: filter by localStorage (anonymous browser sessions)
  useEffect(() => {
    if (open && view === 'sessions') {
      if (config.hubToken) {
        apiRef.current.listSessions(config.hubToken).then(setSessions).catch(() => {});
      } else {
        const savedIds = getSavedSessionIds(config.apiKey);
        if (savedIds.length === 0) {
          setSessions([]);
          return;
        }
        apiRef.current.listSessions().then((all) => {
          setSessions(all.filter((s) => savedIds.includes(s.documentId)));
        }).catch(() => {});
      }
    }
  }, [open, view, config.apiKey, config.hubToken]);

  // WebSocket connection
  useEffect(() => {
    const wsUrl = config.apiUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (sessionId) ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (
          msg.event === 'chat:session_ready' &&
          msg.data?.requestId &&
          msg.data.requestId === pendingRequestId.current
        ) {
          const sid = msg.data.sessionId;
          pendingRequestId.current = null;
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
          setSessionId(sid);
          saveSessionId(config.apiKey, sid);
        }

        const msgId = streamingMsgId.current;

        if (msg.event === 'chat:text_delta') {
          if (!msgId) return;
          setMessages((prev) =>
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
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] }
                : m
            )
          );
        } else if (msg.event === 'chat:done') {
          // message_end fires per iteration — don't finalize here.
          // Mark current tool calls as done but keep streaming for next iteration.
          if (msgId) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== msgId) return m;
                const updatedTools = m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false }));
                return { ...m, toolCalls: updatedTools };
              })
            );
          }
        } else if (msg.event === 'chat:complete') {
          // Fires once after the full agent run — finalize the message with full reply.
          const matchesSession = msg.data?.sessionId && msg.data.sessionId === sessionIdRef.current;
          if (!msgId && !matchesSession) return;

          const reply = msg.data?.reply || '';
          setMessages((prev) =>
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
          setSending(false);
        } else if (msg.event === 'chat:error') {
          if (!msgId) return;
          setMessages((prev) =>
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
          setSending(false);
        }
      } catch {
        /* ignore */
      }
    };

    ws.onerror = () => ws.close();
    return () => { ws.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ws = wsRef.current;
    if (sessionId && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    }
  }, [sessionId]);

  const openSession = useCallback(async (session: WidgetSession) => {
    setSessionId(session.documentId);
    saveSessionId(config.apiKey, session.documentId);
    setSessionTitle(session.title);
    setView('chat');

    const data = await apiRef.current.getSession(session.documentId);
    if (data?.messages) {
      const restored: ChatMessageData[] = data.messages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : '',
          timestamp: Date.now(),
        }));
      setMessages(restored);
    }
  }, []);

  const startNewChat = useCallback(() => {
    setSessionId(undefined);
    setSessionTitle('');
    setMessages([]);
    setView('chat');
  }, []);

  const goBack = useCallback(() => {
    setView('sessions');
    apiRef.current.listSessions().then(setSessions).catch(() => {});
  }, []);

  const handleSend = useCallback(async (text: string, _files: File[]) => {
    if (!text.trim() || sending) return;

    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessageData = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    streamingMsgId.current = assistantId;
    setSending(true);

    const requestId = crypto.randomUUID();
    pendingRequestId.current = requestId;

    try {
      const res = await apiRef.current.sendChat(
        text, sessionId, requestId, config.hubToken, config.hubContext
      );

      if (res.data.sessionId) {
        setSessionId(res.data.sessionId);
        saveSessionId(config.apiKey, res.data.sessionId);
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: res.data.sessionId }));
        }
      }

      // When streaming, WS events handle message updates (chat:done / chat:complete)
      if (!res.data.streaming) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const finalContent = m.content || res.data.reply || '(no response)';
            const finalTools = m.toolCalls?.length
              ? m.toolCalls.map((tc, i) => ({
                  ...tc, isStreaming: false,
                  durationMs: res.data.toolCalls?.[i]?.durationMs ?? tc.durationMs,
                  isError: res.data.toolCalls?.[i]?.isError ?? tc.isError,
                }))
              : res.data.toolCalls?.map((tc: any) => ({
                  id: crypto.randomUUID(), name: tc.name, input: tc.input,
                  durationMs: tc.durationMs, isError: tc.isError,
                }));
            return { ...m, content: finalContent, isStreaming: false, toolCalls: finalTools };
          })
        );
        streamingMsgId.current = null;
        setSending(false);
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${err instanceof Error ? err.message : 'Failed to send'}`, isStreaming: false }
            : m
        )
      );
      streamingMsgId.current = null;
      setSending(false);
    }
  }, [sending, sessionId, config.hubToken, config.hubContext]);

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return 'just now';
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
    return d.toLocaleDateString();
  };

  return (
    <>
      {open && (
        <div style={{
          position: 'fixed', bottom: '88px', [isRight ? 'right' : 'left']: '20px',
          width: `${PANEL_WIDTH}px`, height: `${PANEL_HEIGHT}px`, borderRadius: '12px',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
          backgroundColor: '#0c0c0c', border: '1px solid #333333',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 9999,
        }}>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#333333] bg-[#111111] px-4 py-3">
            <div className="flex items-center gap-2">
              {view === 'chat' && (
                <button
                  onClick={goBack}
                  className="p-1 text-[#666666] hover:text-[#999999] transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              )}
              <span className="font-mono text-sm font-semibold text-[#cccccc]">
                {view === 'sessions' ? 'Conversations' : sessionTitle || 'New Chat'}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 text-[#666666] hover:text-[#999999] transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {view === 'sessions' ? (
            <div className="flex-1 overflow-y-auto">
              {/* New chat button */}
              <button
                onClick={startNewChat}
                className="flex w-full items-center gap-3 border-b border-[#222222] px-4 py-3 text-left transition-colors hover:bg-[#1a1a1a]"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: primaryColor }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
                <span className="text-sm font-medium text-[#cccccc]">New conversation</span>
              </button>

              {sessions.map((s) => (
                <button
                  key={s.documentId}
                  onClick={() => openSession(s)}
                  className="flex w-full flex-col border-b border-[#1a1a1a] px-4 py-3 text-left transition-colors hover:bg-[#1a1a1a]"
                >
                  <span className="text-sm text-[#cccccc] line-clamp-1">{s.title}</span>
                  <span className="mt-0.5 text-xs text-[#666666]">{formatTime(s.updatedAt)}</span>
                </button>
              ))}

              {sessions.length === 0 && (
                <p className="px-4 py-8 text-center text-xs text-[#666666]">No conversations yet</p>
              )}
            </div>
          ) : (
            <>
              <ChatMessages messages={messages} variant="chat" />
              <ChatInput onSend={handleSend} disabled={sending} />
            </>
          )}
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'fixed', bottom: '20px', [isRight ? 'right' : 'left']: '20px',
          width: '56px', height: '56px', borderRadius: '50%',
          backgroundColor: primaryColor, color: '#fff', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 9999, transition: 'transform 0.2s',
        }}
        aria-label={open ? 'Close chat' : 'Open chat'}
      >
        {open ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>
    </>
  );
}
