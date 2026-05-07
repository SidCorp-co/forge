'use client';

import { useCallback } from 'react';
import type { ChatMessageData, ContentBlock } from '@/components/chat/chat-message';
import { convertTodoWriteToTodosBlock, deduplicateTodosBlocks } from '@/lib/utils/todo-blocks';
import { agentApi, type AgentUsage, type PageContext } from '@/features/agent/api';

const EMPTY_USAGE: AgentUsage = { contextUsed: 0, inputTotal: 0, outputTotal: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

function errorMessage(err: unknown, fallback: string): ChatMessageData {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `Error: ${err instanceof Error ? err.message : fallback}`,
    timestamp: Date.now(),
  };
}

interface UseAgentSessionApiOptions {
  projectSlug: string;
  mountedRef: React.MutableRefObject<boolean>;
  streamingMsgId: React.MutableRefObject<string | null>;
  streamingTextRef: React.MutableRefObject<string>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  sessionId: string | null;
  claudeSessionId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setClaudeSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setUsage: React.Dispatch<React.SetStateAction<AgentUsage>>;
  finalize: () => void;
}

export function useAgentSessionApi(opts: UseAgentSessionApiOptions) {
  const {
    projectSlug, mountedRef, streamingMsgId, streamingTextRef, wsRef,
    sessionId, claudeSessionId,
    setMessages, setIsRunning, setSessionId, setClaudeSessionId, setUsage,
    finalize,
  } = opts;

  const startAgent = useCallback(async (prompt: string, startOpts?: { preBuilt?: boolean; issueIds?: string[]; pageContext?: PageContext }) => {
    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };

    streamingMsgId.current = null;
    streamingTextRef.current = '';
    setMessages((prev) => [...prev, userMsg]);
    setIsRunning(true);
    setUsage(EMPTY_USAGE);

    try {
      const res = await agentApi.start({
        projectSlug,
        prompt,
        preBuilt: startOpts?.preBuilt,
        issueIds: startOpts?.issueIds,
        pageContext: startOpts?.pageContext,
      });
      if (!mountedRef.current) return;
      const sid = res.data.documentId;
      setSessionId(sid);
      // Per-session subscribe is handled at the project-room level in
      // useAgentWebSocket; relays for this session land via the project
      // broadcast and createAgentMessageHandler filters by sessionId.
    } catch (err) {
      if (!mountedRef.current) return;
      setMessages((prev) => [...prev, errorMessage(err, 'Failed to start agent')]);
      setIsRunning(false);
    }
  }, [projectSlug, mountedRef, streamingMsgId, streamingTextRef, wsRef, setMessages, setIsRunning, setSessionId, setUsage]);

  const sendMessage = useCallback(async (message: string, sendOpts?: { pageContext?: PageContext }) => {
    if (!sessionId) return;

    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    streamingMsgId.current = null;
    streamingTextRef.current = '';
    setMessages((prev) => [...prev, userMsg]);
    setIsRunning(true);

    try {
      await agentApi.send({
        sessionId,
        message,
        claudeSessionId: claudeSessionId || undefined,
        pageContext: sendOpts?.pageContext,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setMessages((prev) => [...prev, errorMessage(err, 'Failed to send message')]);
      setIsRunning(false);
    }
  }, [sessionId, claudeSessionId, mountedRef, streamingMsgId, streamingTextRef, setMessages, setIsRunning]);

  const abortAgent = useCallback(async () => {
    if (!sessionId) return;
    try {
      await agentApi.abort(sessionId);
    } catch { /* ignore */ }
    finalize();
    setIsRunning(false);
  }, [sessionId, finalize, setIsRunning]);

  /** Convert stored session messages to ChatMessageData array. */
  function parseStoredMessages(stored: any[], sessionStatus?: string): ChatMessageData[] {
    const loaded: ChatMessageData[] = stored.map((m: any, i: number) => {
      const msg: ChatMessageData = {
        id: `stored-${i}`,
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: m.timestamp || Date.now(),
        toolCalls: m.toolCalls,
      };
      if (m.contentBlocks) {
        const converted = m.contentBlocks.map((b: ContentBlock) => {
          if (b.type === 'tool_use' && b.tool.name === 'TodoWrite') {
            return convertTodoWriteToTodosBlock(b.tool.input as any ?? {});
          }
          return b;
        });
        msg.contentBlocks = deduplicateTodosBlocks(converted);
      } else if (msg.role === 'assistant' && (msg.toolCalls?.length || msg.content)) {
        const blocks: ContentBlock[] = [];
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.name === 'TodoWrite') {
              blocks.push(convertTodoWriteToTodosBlock(tc.input as any ?? {}));
            } else {
              blocks.push({ type: 'tool_use', tool: tc });
            }
          }
        }
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        msg.contentBlocks = deduplicateTodosBlocks(blocks);
      }
      return msg;
    }).filter((m: ChatMessageData) => m.content || m.toolCalls?.length || m.contentBlocks?.length);

    // For completed sessions, mark all todos as completed
    if (sessionStatus === 'completed') {
      for (const msg of loaded) {
        if (msg.contentBlocks) {
          msg.contentBlocks = msg.contentBlocks.map((b: ContentBlock) =>
            b.type === 'todos'
              ? { ...b, todos: b.todos.map((t) => ({ ...t, status: 'completed' as const, activeForm: undefined })) }
              : b
          );
        }
      }
    }

    return loaded;
  }

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await agentApi.getSession(id);
      if (!mountedRef.current) return;
      const session = res.data;
      setSessionId(session.documentId);
      setClaudeSessionId(session.claudeSessionId || null);

      const loaded = parseStoredMessages(session.messages || [], session.status);

      setMessages(loaded);
      streamingMsgId.current = null;
      streamingTextRef.current = '';

      // Backfill missing fields from older sessions that lack inputTotal/cacheWrite
      const u = session.usage;
      setUsage(u && u.turns > 0 ? { ...EMPTY_USAGE, ...u } : EMPTY_USAGE);

      setIsRunning(session.status === 'running');
    } catch { /* ignore */ }
  }, [mountedRef, streamingMsgId, streamingTextRef, setMessages, setSessionId, setClaudeSessionId, setIsRunning, setUsage]);

  /**
   * Refresh session data from the server without resetting streaming state.
   * Used by the fallback poll to load messages that may have been missed via WebSocket.
   * Only updates messages if the server has more than what's currently displayed,
   * to avoid clobbering richer WS-streamed content.
   */
  const refreshSession = useCallback(async (id: string) => {
    try {
      const res = await agentApi.getSession(id);
      if (!mountedRef.current) return;
      const session = res.data;
      const isTerminal = session.status !== 'running';
      const stored = session.messages || [];

      // Only replace messages if server has more than what we currently display
      // (avoids clobbering richer WS-streamed content with simpler stored format)
      setMessages((prev) => {
        if (stored.length > prev.length) {
          return parseStoredMessages(stored, session.status);
        }
        // Even if same count, update if terminal and current messages look stale
        // (e.g., last message content is empty or placeholder)
        if (isTerminal && prev.length > 0) {
          const lastMsg = prev[prev.length - 1];
          const lastStored = stored[stored.length - 1];
          if (lastStored && lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.contentBlocks?.length) {
            return parseStoredMessages(stored, session.status);
          }
        }
        return prev;
      });

      if (isTerminal) {
        finalize();
        setIsRunning(false);
      }
    } catch { /* ignore */ }
  }, [mountedRef, setMessages, finalize, setIsRunning]);

  return { startAgent, sendMessage, abortAgent, loadSession, refreshSession };
}
