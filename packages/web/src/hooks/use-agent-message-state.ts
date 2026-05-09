'use client';

import { useReducer, useRef, useEffect } from 'react';
import type {
  ChatMessageData,
  ContentBlock,
  ToolCallData,
  AgentTodo,
} from '@/components/message-bubble/chat-message/chat-message-types';
import type { AgentUsage } from '@/features/agent/api';

export const EMPTY_USAGE: AgentUsage = {
  contextUsed: 0,
  inputTotal: 0,
  outputTotal: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
};

export interface ClaudeRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type BlockOp =
  | { kind: 'textDelta'; text: string }
  | { kind: 'todos'; todos: AgentTodo[] }
  | { kind: 'toolUse'; tool: ToolCallData }
  | { kind: 'toolResult'; toolUseId: string; content: unknown; isError?: boolean };

export interface AgentState {
  messages: ChatMessageData[];
  isRunning: boolean;
  sessionId: string | null;
  claudeSessionId: string | null;
  desktopConnected: boolean;
  usage: AgentUsage;
  streamingMsgId: string | null;
  streamingMsgIndex: number;
  streamingText: string;
  lastUsageMsgId: string | null;
}

export type AgentAction =
  | { type: 'reset' }
  | {
      type: 'messagesReplaced';
      messages: ChatMessageData[];
      usage?: AgentUsage;
      isRunning?: boolean;
      sessionId?: string | null;
      claudeSessionId?: string | null;
    }
  | { type: 'messageAppended'; message: ChatMessageData; isRunning?: boolean }
  | { type: 'userMessageAdded'; id: string; content: string; timestamp: number }
  | {
      type: 'streamFrame';
      blocks: BlockOp[];
      usage?: { rawUsage: ClaudeRawUsage; apiMsgId: string | null };
      /** When true, skip the frame if no streaming message exists (e.g. orphan tool_result). */
      attachOnly?: boolean;
      /** Identity for the assistant message if the reducer needs to create one. */
      newAssistantMessage?: { id: string; timestamp: number };
    }
  | { type: 'streamingDone'; completeTodos?: boolean }
  | { type: 'isRunningSet'; value: boolean }
  | { type: 'sessionIdSet'; value: string | null }
  | { type: 'claudeSessionIdSet'; value: string | null }
  | { type: 'desktopConnectedSet'; value: boolean }
  | { type: 'usageSet'; value: AgentUsage };

const INITIAL_STATE: AgentState = {
  messages: [],
  isRunning: false,
  sessionId: null,
  claudeSessionId: null,
  desktopConnected: false,
  usage: EMPTY_USAGE,
  streamingMsgId: null,
  streamingMsgIndex: -1,
  streamingText: '',
  lastUsageMsgId: null,
};

function finalizeMessage(msg: ChatMessageData, completeTodos?: boolean): ChatMessageData {
  const finalBlocks = completeTodos
    ? msg.contentBlocks?.map((b) =>
        b.type === 'todos'
          ? {
              ...b,
              todos: b.todos.map((t) => ({ ...t, status: 'completed' as const, activeForm: undefined })),
            }
          : b,
      )
    : msg.contentBlocks;
  return {
    ...msg,
    isStreaming: false,
    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })),
    contentBlocks: finalBlocks,
  };
}

function applyBlocks(
  msg: ChatMessageData,
  blocks: BlockOp[],
  prevStreamingText: string,
): { msg: ChatMessageData; streamingText: string } {
  const contentBlocks: ContentBlock[] = [...(msg.contentBlocks || [])];
  let toolCalls: ToolCallData[] | undefined = msg.toolCalls ? [...msg.toolCalls] : undefined;
  let streamingText = prevStreamingText;

  for (const op of blocks) {
    if (op.kind === 'textDelta') {
      streamingText += op.text;
      const last = contentBlocks[contentBlocks.length - 1];
      if (last?.type === 'text') {
        contentBlocks[contentBlocks.length - 1] = { type: 'text', text: last.text + op.text };
      } else {
        contentBlocks.push({ type: 'text', text: op.text });
      }
    } else if (op.kind === 'todos') {
      const todosBlock: ContentBlock = { type: 'todos', todos: op.todos };
      const idx = contentBlocks.findIndex((b) => b.type === 'todos');
      if (idx >= 0) contentBlocks[idx] = todosBlock;
      else contentBlocks.push(todosBlock);
    } else if (op.kind === 'toolUse') {
      contentBlocks.push({ type: 'tool_use', tool: op.tool });
      toolCalls = [...(toolCalls || []), op.tool];
    } else if (op.kind === 'toolResult') {
      const updateTool = (tc: ToolCallData) =>
        tc.id === op.toolUseId
          ? { ...tc, result: op.content, isStreaming: false, isError: op.isError }
          : tc;
      toolCalls = toolCalls?.map(updateTool);
      for (let i = 0; i < contentBlocks.length; i++) {
        const b = contentBlocks[i];
        if (b.type === 'tool_use' && b.tool.id === op.toolUseId) {
          contentBlocks[i] = { ...b, tool: updateTool(b.tool) };
        }
      }
    }
  }

  return {
    msg: { ...msg, content: streamingText, contentBlocks, toolCalls },
    streamingText,
  };
}

function reduceUsage(
  state: AgentState,
  rawUsage: ClaudeRawUsage,
  apiMsgId: string | null,
): { usage: AgentUsage; lastUsageMsgId: string | null } {
  const inp = rawUsage.input_tokens || 0;
  const cr = rawUsage.cache_read_input_tokens || 0;
  const cw = rawUsage.cache_creation_input_tokens || 0;
  const isNewTurn = !apiMsgId || apiMsgId !== state.lastUsageMsgId;
  const contextUsed = inp + cr + cw;
  const prev = state.usage;
  if (!isNewTurn && contextUsed === prev.contextUsed) {
    return { usage: prev, lastUsageMsgId: state.lastUsageMsgId };
  }
  return {
    usage: {
      contextUsed,
      inputTotal: prev.inputTotal + (isNewTurn ? inp : 0),
      outputTotal: prev.outputTotal + (isNewTurn ? rawUsage.output_tokens || 0 : 0),
      cacheRead: prev.cacheRead + (isNewTurn ? cr : 0),
      cacheWrite: prev.cacheWrite + (isNewTurn ? cw : 0),
      turns: prev.turns + (isNewTurn ? 1 : 0),
    },
    lastUsageMsgId: isNewTurn ? apiMsgId : state.lastUsageMsgId,
  };
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_STATE, desktopConnected: state.desktopConnected };

    case 'messagesReplaced': {
      const next: AgentState = {
        ...state,
        messages: action.messages,
        streamingMsgId: null,
        streamingMsgIndex: -1,
        streamingText: '',
        lastUsageMsgId: null,
      };
      if (action.usage !== undefined) next.usage = action.usage;
      if (action.isRunning !== undefined) next.isRunning = action.isRunning;
      if (action.sessionId !== undefined) next.sessionId = action.sessionId;
      if (action.claudeSessionId !== undefined) next.claudeSessionId = action.claudeSessionId;
      return next;
    }

    case 'messageAppended': {
      const messages = [...state.messages, action.message];
      return {
        ...state,
        messages,
        isRunning: action.isRunning !== undefined ? action.isRunning : state.isRunning,
      };
    }

    case 'userMessageAdded': {
      let messages = state.messages;
      if (state.streamingMsgId && state.streamingMsgIndex >= 0) {
        const idx = state.streamingMsgIndex;
        const next = messages.slice();
        next[idx] = finalizeMessage(next[idx]);
        messages = next;
      }
      messages = [
        ...messages,
        {
          id: action.id,
          role: 'user',
          content: action.content,
          timestamp: action.timestamp,
        },
      ];
      return {
        ...state,
        messages,
        isRunning: true,
        streamingMsgId: null,
        streamingMsgIndex: -1,
        streamingText: '',
      };
    }

    case 'streamFrame': {
      if (action.attachOnly && !state.streamingMsgId) return state;

      let messages = state.messages;
      let streamingMsgId = state.streamingMsgId;
      let streamingMsgIndex = state.streamingMsgIndex;
      let streamingText = state.streamingText;
      let isRunning = state.isRunning;

      if (!streamingMsgId) {
        const seed = action.newAssistantMessage;
        if (!seed) return state;
        streamingMsgId = seed.id;
        streamingMsgIndex = messages.length;
        streamingText = '';
        isRunning = true;
        messages = [
          ...messages,
          {
            id: streamingMsgId,
            role: 'assistant',
            content: '',
            timestamp: seed.timestamp,
            isStreaming: true,
            contentBlocks: [],
          },
        ];
      }

      if (action.blocks.length > 0) {
        const next = messages.slice();
        const applied = applyBlocks(next[streamingMsgIndex], action.blocks, streamingText);
        next[streamingMsgIndex] = applied.msg;
        messages = next;
        streamingText = applied.streamingText;
      }

      let usage = state.usage;
      let lastUsageMsgId = state.lastUsageMsgId;
      if (action.usage) {
        const u = reduceUsage(state, action.usage.rawUsage, action.usage.apiMsgId);
        usage = u.usage;
        lastUsageMsgId = u.lastUsageMsgId;
      }

      return {
        ...state,
        messages,
        isRunning,
        streamingMsgId,
        streamingMsgIndex,
        streamingText,
        usage,
        lastUsageMsgId,
      };
    }

    case 'streamingDone': {
      let messages = state.messages;
      if (state.streamingMsgId && state.streamingMsgIndex >= 0) {
        const idx = state.streamingMsgIndex;
        const next = messages.slice();
        next[idx] = finalizeMessage(next[idx], action.completeTodos);
        messages = next;
      }
      return {
        ...state,
        messages,
        streamingMsgId: null,
        streamingMsgIndex: -1,
        streamingText: '',
      };
    }

    case 'isRunningSet':
      return state.isRunning === action.value ? state : { ...state, isRunning: action.value };

    case 'sessionIdSet':
      return state.sessionId === action.value ? state : { ...state, sessionId: action.value };

    case 'claudeSessionIdSet':
      return state.claudeSessionId === action.value
        ? state
        : { ...state, claudeSessionId: action.value };

    case 'desktopConnectedSet':
      return state.desktopConnected === action.value
        ? state
        : { ...state, desktopConnected: action.value };

    case 'usageSet':
      return { ...state, usage: action.value };

    default:
      return state;
  }
}

export function useAgentMessageState() {
  const [state, dispatch] = useReducer(agentReducer, INITIAL_STATE);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { state, dispatch, mountedRef, sessionIdRef };
}
