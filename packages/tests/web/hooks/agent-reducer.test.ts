import { describe, it, expect } from 'vitest';
import {
  agentReducer,
  EMPTY_USAGE,
  type AgentState,
  type BlockOp,
} from '@/hooks/use-agent-message-state';

const INITIAL: AgentState = {
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

describe('agentReducer', () => {
  it('streamFrame creates an assistant message and applies multiple block ops in one pass', () => {
    const blocks: BlockOp[] = [
      { kind: 'textDelta', text: 'Hello' },
      {
        kind: 'toolUse',
        tool: { id: 't1', name: 'Read', input: { path: '/x' }, isStreaming: true },
      },
      { kind: 'toolResult', toolUseId: 't1', content: 'ok' },
    ];
    const next = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks,
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });

    expect(next.messages).not.toBe(INITIAL.messages);
    expect(next.messages).toHaveLength(1);
    expect(next.streamingMsgIndex).toBe(0);
    expect(next.isRunning).toBe(true);

    const msg = next.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.isStreaming).toBe(true);
    expect(msg.contentBlocks).toEqual([
      { type: 'text', text: 'Hello' },
      {
        type: 'tool_use',
        tool: { id: 't1', name: 'Read', input: { path: '/x' }, isStreaming: false, result: 'ok', isError: undefined },
      },
    ]);
    expect(msg.toolCalls?.[0].result).toBe('ok');
    expect(msg.toolCalls?.[0].isStreaming).toBe(false);
  });

  it('consecutive textDelta blocks merge into the trailing text block', () => {
    let state = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [{ kind: 'textDelta', text: 'foo' }],
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });
    state = agentReducer(state, {
      type: 'streamFrame',
      blocks: [{ kind: 'textDelta', text: 'bar' }],
    });

    const msg = state.messages[0];
    expect(msg.contentBlocks).toHaveLength(1);
    expect(msg.contentBlocks?.[0]).toEqual({ type: 'text', text: 'foobar' });
    expect(msg.content).toBe('foobar');
  });

  it('streamFrame usage advances totals; same apiMsgId does not double-count', () => {
    const usage = {
      rawUsage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      apiMsgId: 'msg_1',
    };
    let state = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [],
      usage,
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });
    expect(state.usage.turns).toBe(1);
    expect(state.usage.inputTotal).toBe(10);
    expect(state.usage.outputTotal).toBe(5);
    expect(state.usage.cacheRead).toBe(2);
    expect(state.usage.cacheWrite).toBe(1);

    // Same apiMsgId — should not double-count.
    const beforeRedup = state.usage;
    state = agentReducer(state, { type: 'streamFrame', blocks: [], usage });
    expect(state.usage.turns).toBe(1);
    expect(state.usage.inputTotal).toBe(10);
    expect(state.usage).toBe(beforeRedup);

    // New apiMsgId — should advance.
    state = agentReducer(state, {
      type: 'streamFrame',
      blocks: [],
      usage: { rawUsage: { input_tokens: 3, output_tokens: 2 }, apiMsgId: 'msg_2' },
    });
    expect(state.usage.turns).toBe(2);
    expect(state.usage.inputTotal).toBe(13);
  });

  it('userMessageAdded finalizes prior streaming message and resets streaming bookkeeping', () => {
    let state = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [{ kind: 'textDelta', text: 'partial' }],
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });
    expect(state.streamingMsgId).not.toBeNull();

    state = agentReducer(state, {
      type: 'userMessageAdded',
      id: 'user-1',
      content: 'next prompt',
      timestamp: 2000,
    });

    expect(state.streamingMsgId).toBeNull();
    expect(state.streamingMsgIndex).toBe(-1);
    expect(state.streamingText).toBe('');
    expect(state.isRunning).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].isStreaming).toBe(false);
    expect(state.messages[1].role).toBe('user');
    expect(state.messages[1].content).toBe('next prompt');
  });

  it('attachOnly streamFrame is a no-op when no streaming message exists', () => {
    const next = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [{ kind: 'toolResult', toolUseId: 'orphan', content: 'x' }],
      attachOnly: true,
    });
    expect(next).toBe(INITIAL);
  });

  it('streamingDone with completeTodos marks todos completed and finalizes msg', () => {
    let state = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [
        {
          kind: 'todos',
          todos: [
            { content: 'a', status: 'in_progress', activeForm: 'doing a' },
            { content: 'b', status: 'pending' },
          ],
        },
      ],
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });
    state = agentReducer(state, { type: 'streamingDone', completeTodos: true });
    const msg = state.messages[0];
    expect(msg.isStreaming).toBe(false);
    const todosBlock = msg.contentBlocks?.[0];
    expect(todosBlock?.type).toBe('todos');
    if (todosBlock?.type === 'todos') {
      expect(todosBlock.todos.every((t) => t.status === 'completed')).toBe(true);
      expect(todosBlock.todos.every((t) => t.activeForm === undefined)).toBe(true);
    }
    expect(state.streamingMsgId).toBeNull();
  });

  it('todos block is replaced in place, not appended', () => {
    let state = agentReducer(INITIAL, {
      type: 'streamFrame',
      blocks: [{ kind: 'todos', todos: [{ content: 'a', status: 'pending' }] }],
      newAssistantMessage: { id: 'asst-1', timestamp: 1000 },
    });
    state = agentReducer(state, {
      type: 'streamFrame',
      blocks: [{ kind: 'todos', todos: [{ content: 'a', status: 'completed' }] }],
    });

    const blocks = state.messages[0].contentBlocks!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'todos',
      todos: [{ content: 'a', status: 'completed' }],
    });
  });

  it('messagesReplaced clears lastUsageMsgId so a new session does not collide with the prior one', () => {
    const seeded: AgentState = { ...INITIAL, lastUsageMsgId: 'msg_old', sessionId: 'sess_a' };
    const next = agentReducer(seeded, {
      type: 'messagesReplaced',
      messages: [],
      sessionId: 'sess_b',
    });
    expect(next.lastUsageMsgId).toBeNull();
  });

  it('reset preserves desktopConnected', () => {
    const state: AgentState = { ...INITIAL, desktopConnected: true, isRunning: true, sessionId: 'x' };
    const next = agentReducer(state, { type: 'reset' });
    expect(next.desktopConnected).toBe(true);
    expect(next.isRunning).toBe(false);
    expect(next.sessionId).toBeNull();
  });
});
