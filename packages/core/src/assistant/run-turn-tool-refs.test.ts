/**
 * ISS-1057 — what a tool call records about what it returned.
 *
 * `run-turn-core.test.ts` is at the file budget, so this one case lives here: it is the one that
 * makes the reply screen able to answer "did this turn look that id up?" without re-querying.
 */

import { describe, expect, it } from 'vitest';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { CallToolResult } from '../mcp/tool-result.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { runTurnEvents, type TurnCoreResult } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

async function drain(gen: AsyncGenerator<ChatStreamEvent, TurnCoreResult>) {
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

function provider(rounds: ChatStreamEvent[][]): ChatProvider {
  let call = 0;
  return {
    id: 'mock',
    defaultModel: 'm',
    async *stream(): AsyncIterable<ChatStreamEvent> {
      const round = rounds[Math.min(call, rounds.length - 1)] ?? [{ type: 'done' }];
      call += 1;
      for (const e of round) yield e;
    },
  };
}

describe('ToolCallRecord.resultIssueRefs', () => {
  it('records the issue references a tool result named, past the preview cut', async () => {
    const long = `${'x'.repeat(600)} ISS-538 and iss-11`;
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'list', parameters: {} } }],
      execute: async () => ok(long),
    };
    const result = await drain(
      runTurnEvents({
        provider: provider([
          [{ type: 'tool_call', id: 'c1', name: 'list', arguments: '{}' }, { type: 'done' }],
          [{ type: 'chunk', text: 'ok' }, { type: 'done' }],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tools,
      }),
    );
    const call = result.toolCalls[0] as { resultPreview: string; resultIssueRefs: string[] };
    expect(call.resultPreview).not.toContain('ISS-538');
    expect(call.resultIssueRefs).toEqual(['ISS-538', 'ISS-11']);
  });

  it('keeps every reference a long listing named, past any audit cap', async () => {
    const many = Array.from({ length: 120 }, (_, i) => formatIssueRef('ISS', i + 1)).join(' ');
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'list', parameters: {} } }],
      execute: async () => ok(many),
    };
    const result = await drain(
      runTurnEvents({
        provider: provider([
          [{ type: 'tool_call', id: 'c1', name: 'list', arguments: '{}' }, { type: 'done' }],
          [{ type: 'chunk', text: 'ok' }, { type: 'done' }],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tools,
      }),
    );
    const call = result.toolCalls[0] as { resultIssueRefs: string[] };
    expect(call.resultIssueRefs).toHaveLength(120);
    expect(call.resultIssueRefs).toContain('ISS-120');
  });
});
