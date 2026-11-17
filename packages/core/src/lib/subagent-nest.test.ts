// @direct-test-of packages/runner/crates/runner-agent/fixtures/stream-json/agent.jsonl
// @direct-test-of packages/runner/crates/runner-agent/fixtures/stream-json/interrupt.jsonl
// @direct-test-of packages/core/src/lib/subagent-nest.ts
// ISS-1268 A2: a real Claude Code 2.1.322 turn that spawned an `Agent` (captured from a throwaway
// `claude -p --output-format stream-json --forward-subagent-text` run) folds with the subagent's
// tool calls under the call that spawned it, not beside the session's own reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AgentMessage,
  applyEventsToState,
  createDeriveState,
  parseStreamMessages,
} from './agent-stream-parser.js';

function fixture(name: string): unknown[] {
  const path = fileURLToPath(
    new URL(
      `../../../runner/crates/runner-agent/fixtures/stream-json/${name}.jsonl`,
      import.meta.url,
    ),
  );
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

function fold(lines: unknown[]): AgentMessage[] {
  const state = createDeriveState();
  applyEventsToState(
    state,
    lines.map((line, i) => ({ kind: 'stdout', data: { line }, ts: 1_000 + i })),
  );
  return state.messages;
}

const toolsOf = (messages: AgentMessage[]) =>
  messages.flatMap((m) => (m.blocks ?? []).flatMap((b) => (b.toolCall ? [b.toolCall] : [])));

describe('a subagent folds under the Agent call that spawned it', () => {
  const messages = fold(fixture('agent'));
  const agent = toolsOf(messages).find((t) => t.name === 'Agent');

  it('nests the subagent’s Bash call, settled, under the Agent call', () => {
    expect(agent).toBeDefined();
    const nested = (agent?.subagent ?? []).flatMap((b) => (b.toolCall ? [b.toolCall] : []));
    expect(nested.map((t) => t.name)).toEqual(['Bash']);
    expect(nested[0]?.output).toContain('agent.jsonl');
    const said = (agent?.subagent ?? []).filter((b) => b.type === 'text').map((b) => b.text);
    expect(said.join('')).toContain('6 entries');
  });

  it('keeps the subagent’s calls and words out of the session’s own reply', () => {
    expect(toolsOf(messages).map((t) => t.name)).toEqual(['Agent']);
    const own = messages.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text'));
    expect(own.map((b) => b.text).join(' ')).not.toContain('6 entries in /work.');
  });
});

describe('a result says why the turn ended and what each model spent', () => {
  it('reads terminal_reason and modelUsage off a stopped turn', () => {
    const results = fold(fixture('interrupt')).filter((m) => m.subtype === 'result');
    expect(results.map((m) => m.totals?.terminalReason)).toEqual([
      'aborted_streaming',
      'completed',
    ]);
    const models = results[1]?.totals?.models ?? {};
    expect(Object.values(models)[0]?.contextWindow).toBe(1_000_000);
  });
});

describe('TodoWrite is a tool call like any other', () => {
  it('folds to a tool block, never a todo panel', () => {
    const [message] = parseStreamMessages(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [] } }],
        },
      },
      () => 'm1',
    ).messages;
    expect(message?.blocks?.map((b) => b.type)).toEqual(['tool']);
  });
});
