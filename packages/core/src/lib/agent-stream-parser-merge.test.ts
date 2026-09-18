/**
 * ISS-1030 — what a continued assistant turn keeps.
 *
 * The CLI emits one turn as several `assistant` lines and the fold merges them
 * into one growing entry. Everything about that merge which is not simply "text
 * and tool calls" lives here, because the filter that used to do it silently
 * dropped every other block member — a turn whose TodoWrite landed on any line
 * but the first stored no todo list at all, on the pipeline path as well as the
 * chat one.
 */
import { describe, expect, it } from 'vitest';
import {
  type AgentMessage,
  createIdFactory,
  mergeMessages,
  parseStreamMessages,
} from './agent-stream-parser.js';

const makeId = () => createIdFactory();

describe('a continued assistant turn', () => {
  // cm:guard the case ISS-1030 found: the continuation filter admitted `text` and
  // unseen `tool` blocks and dropped every other member, so a turn whose
  // TodoWrite landed on any assistant line but the first stored no todo list at
  // all — on the pipeline path as well as the chat one. The assertion is on the
  // BLOCKS a thread draws, because the todo list has no other home.
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
