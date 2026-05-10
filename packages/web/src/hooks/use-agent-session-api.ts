'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessageData, ContentBlock } from '@/components/chat/chat-message';
import { convertTodoWriteToTodosBlock, deduplicateTodosBlocks } from '@/lib/utils/todo-blocks';
import { agentApi, type AgentUsage, type PageContext } from '@/features/agent/api';
import { unwrap } from '@/lib/api/client';
import { EMPTY_USAGE, type AgentAction } from './use-agent-message-state';

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
  sessionId: string | null;
  claudeSessionId: string | null;
  messagesRef: React.MutableRefObject<ChatMessageData[]>;
  dispatch: React.Dispatch<AgentAction>;
}

export function useAgentSessionApi(opts: UseAgentSessionApiOptions) {
  const { projectSlug, mountedRef, sessionId, claudeSessionId, messagesRef, dispatch } = opts;
  const queryClient = useQueryClient();

  const startAgent = useCallback(async (prompt: string, startOpts?: { preBuilt?: boolean; issueIds?: string[]; pageContext?: PageContext }) => {
    dispatch({
      type: 'userMessageAdded',
      id: crypto.randomUUID(),
      content: prompt,
      timestamp: Date.now(),
    });
    dispatch({ type: 'usageSet', value: EMPTY_USAGE });

    try {
      const res = await agentApi.start({
        projectSlug,
        prompt,
        preBuilt: startOpts?.preBuilt,
        issueIds: startOpts?.issueIds,
        pageContext: startOpts?.pageContext,
      });
      if (!mountedRef.current) return;
      dispatch({ type: 'sessionIdSet', value: unwrap(res).documentId });
    } catch (err) {
      if (!mountedRef.current) return;
      dispatch({
        type: 'messageAppended',
        message: errorMessage(err, 'Failed to start agent'),
        isRunning: false,
      });
    }
  }, [projectSlug, mountedRef, dispatch]);

  const sendMessage = useCallback(async (message: string, sendOpts?: { pageContext?: PageContext }) => {
    if (!sessionId) return;

    dispatch({
      type: 'userMessageAdded',
      id: crypto.randomUUID(),
      content: message,
      timestamp: Date.now(),
    });

    try {
      await agentApi.send({
        sessionId,
        message,
        claudeSessionId: claudeSessionId || undefined,
        pageContext: sendOpts?.pageContext,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      dispatch({
        type: 'messageAppended',
        message: errorMessage(err, 'Failed to send message'),
        isRunning: false,
      });
    }
  }, [sessionId, claudeSessionId, mountedRef, dispatch]);

  const abortAgent = useCallback(async () => {
    if (!sessionId) return;
    try {
      await agentApi.abort(sessionId);
    } catch { /* ignore */ }
    dispatch({ type: 'streamingDone' });
    dispatch({ type: 'isRunningSet', value: false });
  }, [sessionId, dispatch]);

  /** Convert stored session messages to ChatMessageData array. */
  function parseStoredMessages(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stored: any[],
    sessionStatus?: string,
    turnsByIndex?: Map<number, { id: string; editedAt: string | null }>,
  ): ChatMessageData[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded: ChatMessageData[] = stored.map((m: any, i: number) => {
      const turn = turnsByIndex?.get(i);
      const msg: ChatMessageData = {
        id: `stored-${i}`,
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: m.timestamp || Date.now(),
        toolCalls: m.toolCalls,
        ...(turn ? { turnId: turn.id, turnIndex: i, turnEditedAt: turn.editedAt } : {}),
      };
      if (m.contentBlocks) {
        const converted = m.contentBlocks.map((b: ContentBlock) => {
          if (b.type === 'tool_use' && b.tool.name === 'TodoWrite') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const session = unwrap(res);

      // Prime the per-session React Query cache so the Changes tab reads
      // from cache instead of refetching `/agent-sessions/:id`.
      queryClient.setQueryData(['agent-session', id], { data: session });

      let turnsByIndex: Map<number, { id: string; editedAt: string | null }> | undefined;
      try {
        const turnsRes = await agentApi.getTurns(id, { limit: 500 });
        if (turnsRes?.turns?.length) {
          turnsByIndex = new Map(
            turnsRes.turns.map((t) => [t.turnIndex, { id: t.id, editedAt: t.editedAt }]),
          );
        }
      } catch {
        /* older sessions have no turns yet during dual-write rollout */
      }

      const loaded = parseStoredMessages(session.messages || [], session.status, turnsByIndex);
      const u: AgentUsage | undefined = session.usage;
      const usage = u && u.turns > 0 ? { ...EMPTY_USAGE, ...u } : EMPTY_USAGE;

      dispatch({
        type: 'messagesReplaced',
        messages: loaded,
        usage,
        isRunning: session.status === 'running',
        sessionId: session.documentId,
        claudeSessionId: session.claudeSessionId || null,
      });
    } catch { /* ignore */ }
  }, [mountedRef, dispatch, queryClient]);

  /**
   * Refresh session data from the server without resetting streaming state.
   * Only replaces messages if the server has more than what's currently displayed,
   * to avoid clobbering richer WS-streamed content.
   */
  const refreshSession = useCallback(async (id: string) => {
    try {
      const res = await agentApi.getSession(id);
      if (!mountedRef.current) return;
      const session = unwrap(res);

      // Keep the Changes-tab cache fresh when WS/poll reconciles a row.
      queryClient.setQueryData(['agent-session', id], { data: session });

      const isTerminal = session.status !== 'running';
      const stored = session.messages || [];
      const currentMessages = messagesRef.current;

      let nextMessages: ChatMessageData[] | null = null;
      if (stored.length > currentMessages.length) {
        nextMessages = parseStoredMessages(stored, session.status);
      } else if (isTerminal && currentMessages.length > 0) {
        const lastMsg = currentMessages[currentMessages.length - 1];
        const lastStored = stored[stored.length - 1];
        if (lastStored && lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.contentBlocks?.length) {
          nextMessages = parseStoredMessages(stored, session.status);
        }
      }

      if (nextMessages) {
        dispatch({ type: 'messagesReplaced', messages: nextMessages });
      }

      if (isTerminal) {
        dispatch({ type: 'streamingDone' });
        dispatch({ type: 'isRunningSet', value: false });
      }
    } catch { /* ignore */ }
  }, [mountedRef, messagesRef, dispatch, queryClient]);

  const editTurn = useCallback(
    async (turnId: string, content: string, expectedEditedAt?: string) => {
      if (!sessionId) return;
      await agentApi.editTurn(sessionId, turnId, {
        content,
        ...(expectedEditedAt ? { expectedEditedAt } : {}),
      });
      await loadSession(sessionId);
    },
    [sessionId, loadSession],
  );

  const regenerateTurn = useCallback(
    async (turnId: string) => {
      if (!sessionId) return;
      await agentApi.regenerateTurn(sessionId, turnId);
      dispatch({ type: 'isRunningSet', value: true });
      await loadSession(sessionId);
    },
    [sessionId, loadSession, dispatch],
  );

  const forkSession = useCallback(
    async (fromTurnId: string) => {
      if (!sessionId) return null;
      const res = await agentApi.forkSession(sessionId, fromTurnId);
      return res.documentId;
    },
    [sessionId],
  );

  const rerunSession = useCallback(async () => {
    if (!sessionId) return null;
    const res = await agentApi.rerunSession(sessionId);
    return res.documentId;
  }, [sessionId]);

  return {
    startAgent,
    sendMessage,
    abortAgent,
    loadSession,
    refreshSession,
    editTurn,
    regenerateTurn,
    forkSession,
    rerunSession,
  };
}
