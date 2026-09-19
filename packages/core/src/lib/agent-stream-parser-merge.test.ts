import { describe, expect, it } from 'vitest';
import {
  type AgentMessage,
  createIdFactory,
  mergeMessages,
  parseStreamMessages,
} from './agent-stream-parser.js';

const makeId = () => createIdFactory();

describe('a continued assistant turn', () => {
  it('carries a todo list that arrives on a continuation rather than dropping it', () => {
    const id = makeId();
    const messages: AgentMessage[] = [];
    mergeMessages(
      messages,
      parseStreamMessages(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } },
        id,
      ).messages,
    );
    mergeMessages(
      messages,
      parseStreamMessages(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'TodoWrite',
                input: { todos: [{ content: 'one', status: 'pending' }] },
              },
            ],
          },
        },
        id,
      ).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks?.map((b) => b.type)).toEqual(['text', 'todos']);
    expect(messages[0]?.blocks?.[1]?.todos).toEqual([{ content: 'one', status: 'pending' }]);
  });

  it('replaces the todo list rather than keeping two versions of one list', () => {
    const id = makeId();
    const messages: AgentMessage[] = [];
    const write = (status: string) =>
      parseStreamMessages(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `t-${status}`,
                name: 'TodoWrite',
                input: { todos: [{ content: 'one', status }] },
              },
            ],
          },
        },
        id,
      ).messages;
    mergeMessages(messages, write('pending'));
    mergeMessages(messages, write('completed'));
    const todos = messages[0]?.blocks?.filter((b) => b.type === 'todos') ?? [];
    expect(todos).toHaveLength(1);
    expect(todos[0]?.todos).toEqual([{ content: 'one', status: 'completed' }]);
  });
});
