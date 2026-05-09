'use client';

import type { AgentAction, BlockOp } from './use-agent-message-state';
import type { ToolCallData } from '@/components/chat/chat-message/chat-message-types';
import { convertTodoWriteToTodosBlock } from '@/lib/utils/todo-blocks';

interface AgentHandlerOptions {
  projectSlug: string;
  sessionIdRef: React.MutableRefObject<string | null>;
  dispatch: React.Dispatch<AgentAction>;
  handlePromptBuilt: (requestId: string, prompt: string | null, error: string | null) => void;
  handlePreviewPrompt: (prompt: string, issueIds: string[] | undefined) => void;
}

export function createAgentMessageHandler(opts: AgentHandlerOptions) {
  const { projectSlug, sessionIdRef, dispatch, handlePromptBuilt, handlePreviewPrompt } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function route(msg: any): void {
    if (msg.event === 'desktop:connected' || msg.event === 'desktop:disconnected') {
      import('@/features/agent/api').then(({ agentApi }) => {
        agentApi
          .desktopStatus({ projectSlug })
          .then((res) => {
            dispatch({ type: 'desktopConnectedSet', value: res?.data?.connected ?? false });
          })
          .catch(() => {});
      });
      return;
    }

    if (msg.event === 'agent:prompt-built') {
      const { requestId, prompt, error } = msg.data || {};
      handlePromptBuilt(requestId, prompt, error);
      return;
    }

    if (msg.event === 'agent:preview-prompt') {
      const { prompt, issueIds, projectSlug: promptProjectSlug } = msg.data || {};
      if (prompt && promptProjectSlug === projectSlug) {
        sessionIdRef.current = null;
        dispatch({ type: 'reset' });
        handlePreviewPrompt(prompt, issueIds);
      }
      return;
    }

    const currentSessionId = sessionIdRef.current;
    if (msg.data?.sessionId && currentSessionId && msg.data.sessionId !== currentSessionId) return;

    if (msg.data?.sessionId && !currentSessionId) {
      sessionIdRef.current = msg.data.sessionId;
      dispatch({ type: 'sessionIdSet', value: msg.data.sessionId });
    }

    if (msg.event === 'agent:user-message') {
      const content = msg.data?.content;
      if (content) {
        dispatch({
          type: 'userMessageAdded',
          id: crypto.randomUUID(),
          content,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (msg.event === 'agent:message') {
      handleAgentMessage(msg.data);
    } else if (msg.event === 'agent:complete' || msg.event === 'agent:error') {
      // agent:error is defensive forward-compat — core currently rides
      // failures on agent:complete.data.error, but mirror behavior if a
      // dedicated frame is ever emitted. claudeSessionId capture only
      // makes sense on agent:complete.
      if (msg.event === 'agent:complete' && msg.data?.claudeSessionId) {
        dispatch({ type: 'claudeSessionIdSet', value: msg.data.claudeSessionId });
      }
      const errorText: string | null = typeof msg.data?.error === 'string' ? msg.data.error : null;
      if (errorText) {
        dispatch({
          type: 'streamFrame',
          blocks: [{ kind: 'textDelta', text: `Error: ${errorText}` }],
          newAssistantMessage: { id: crypto.randomUUID(), timestamp: Date.now() },
        });
      }
      dispatch({ type: 'streamingDone', completeTodos: true });
      dispatch({ type: 'isRunningSet', value: false });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function handleMessage(msg: any) {
    if (typeof msg.event === 'string' && msg.event.startsWith('agent-session.relay.')) {
      const innerEvent = msg.event.slice('agent-session.relay.'.length);
      const wrap = msg.data ?? {};
      msg = {
        ...msg,
        event: innerEvent,
        data: { sessionId: wrap.sessionId, ...(wrap.payload ?? {}) },
      };
    }

    if (msg.event === 'agent:batch' && Array.isArray(msg.data?.items)) {
      const sessionId = msg.data.sessionId;
      for (const item of msg.data.items) {
        route({
          event: item.event,
          data: { sessionId, ...(item.data ?? {}) },
        });
      }
      return;
    }

    route(msg);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleAgentMessage(d: any) {
    const content = d.message?.content;

    if (d.type === 'assistant' && Array.isArray(content)) {
      const blocks: BlockOp[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          blocks.push({ kind: 'textDelta', text: block.text });
        } else if (block.type === 'tool_use' && block.name === 'TodoWrite') {
          const { todos } = convertTodoWriteToTodosBlock(block.input ?? {});
          blocks.push({ kind: 'todos', todos });
        } else if (block.type === 'tool_use') {
          const tool: ToolCallData = {
            id: block.id || crypto.randomUUID(),
            name: block.name || 'tool',
            input: block.input,
            isStreaming: true,
          };
          blocks.push({ kind: 'toolUse', tool });
        }
      }

      const rawUsage = d.usage || d.message?.usage;
      const apiMsgId: string | null = d.message?.id ?? null;
      const usage = rawUsage ? { rawUsage, apiMsgId } : undefined;

      if (blocks.length > 0 || usage) {
        dispatch({
          type: 'streamFrame',
          blocks,
          usage,
          newAssistantMessage: { id: crypto.randomUUID(), timestamp: Date.now() },
        });
      }
    } else if (d.type === 'user' && Array.isArray(content)) {
      const blocks: BlockOp[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          blocks.push({
            kind: 'toolResult',
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: block.is_error,
          });
        }
      }
      if (blocks.length > 0) {
        dispatch({ type: 'streamFrame', blocks, attachOnly: true });
      }
    } else if (d.type === 'text' && typeof d.content === 'string') {
      dispatch({
        type: 'streamFrame',
        blocks: [{ kind: 'textDelta', text: d.content as string }],
        newAssistantMessage: { id: crypto.randomUUID(), timestamp: Date.now() },
      });
    } else if (d.type === 'error' && typeof d.content === 'string') {
      dispatch({
        type: 'streamFrame',
        blocks: [{ kind: 'textDelta', text: `Error: ${d.content}` }],
        newAssistantMessage: { id: crypto.randomUUID(), timestamp: Date.now() },
      });
    } else if (d.type === 'system' && d.session_id) {
      dispatch({ type: 'claudeSessionIdSet', value: d.session_id });
    }
  }
}
