import { describe, expect, it, vi } from 'vitest';

// cm:why the SSE callback is run against a fake stream, because what this file judges is the events
// a turn emits and their order, which no HTTP assertion over the body can separate from framing.
const captured: Array<{ event: string; data: string }> = [];
vi.mock('hono/streaming', () => ({
  streamSSE: async (
    _c: unknown,
    cb: (s: {
      writeSSE: (m: { event: string; data: string }) => Promise<void>;
      onAbort: (f: () => void) => void;
    }) => Promise<void>,
  ) => {
    const stream = {
      writeSSE: async (m: { event: string; data: string }) => {
        captured.push(m);
      },
      onAbort: () => {},
    };
    await cb(stream);
    return undefined;
  },
}));

// cm:why the audit row and the message rows both reach the database, and this file is about the SSE
// stream rather than either of them.
vi.mock('../db/client.js', () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));
const appended: string[] = [];
const silences: string[] = [];
/** Every assistant/silence append, with the blocks it carried. */
const persisted: Array<{
  text: string;
  blocks: unknown;
  silenceReason: string | null;
  id: string | null;
}> = [];
vi.mock('./conversation-turn.js', () => ({
  appendAssistantMessage: (
    t: { pending: unknown[] },
    text: string,
    opts?: { blocks?: unknown; id?: string | null },
  ) => {
    appended.push(text);
    persisted.push({
      text,
      blocks: opts?.blocks ?? null,
      silenceReason: null,
      id: opts?.id ?? null,
    });
    t.pending.push({
      role: 'assistant',
      id: opts?.id ?? null,
      content: text,
      blocks: opts?.blocks ?? null,
    });
  },
  appendSilence: (
    t: { pending: unknown[] },
    reason: string,
    opts?: { blocks?: unknown; id?: string | null },
  ) => {
    silences.push(reason);
    persisted.push({
      text: '',
      blocks: opts?.blocks ?? null,
      silenceReason: reason,
      id: opts?.id ?? null,
    });
    t.pending.push({
      id: opts?.id ?? null,
      role: 'assistant',
      content: '',
      silenceReason: reason,
      blocks: opts?.blocks ?? null,
    });
  },
  // cm:why the mock RETURNS rows: `runChatTurn` reads the written row back and streams it as the
  // final frame, which is what makes the stream and the transcript one thing rather than two that
  // resemble each other. A mock returning nothing would hide that frame from every assertion.
  persistMessages: async (t: { pending: Array<Record<string, unknown>> }) => {
    // cm:guard the double honours a caller-supplied `id` because the REAL insert does: the column
    // default only mints one where the caller did not. A double that always minted its own is what
    // let ISS-1029 ship streaming 19 frames under one id and settling under another — the assertion
    // below could not have failed against it, whatever the production code did.
    const rows = t.pending.map((m, i) => ({
      id: (m.id as string | null) ?? `row-${i}`,
      seq: i,
      externalId: null,
      role: m.role as string,
      authorUserId: null,
      authorLabel: null,
      authorKey: null,
      content: m.content as string,
      blocks: (m.blocks ?? null) as unknown,
      images: [],
      deliveryProof: null,
      silenceReason: (m.silenceReason ?? null) as string | null,
      createdAt: new Date(0),
    }));
    t.pending.length = 0;
    return rows;
  },
  toCanonicalEntry: (row: Record<string, unknown>) => ({
    id: row.id,
    type: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant',
    timestamp: (row.createdAt as Date).getTime(),
    ...((row.content as string).length > 0 ? { content: row.content } : {}),
    ...(row.blocks ? { blocks: row.blocks } : {}),
  }),
}));

const { runChatTurn } = await import('./run-turn.js');

import type { ConversationTurn } from './conversation-turn.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

function fakeCtx() {
  return { header: () => {} } as never;
}

function turn(): ConversationTurn {
  return { conversationId: 'c1', adapter: 'web', handleUserId: null, history: [], pending: [] };
}

type RawBlock = Record<string, unknown>;

// cm:guard these REFUSE by name rather than casting past an absence. What this file judges is which
// block landed at which index, and an accessor that yields `undefined` for a missing one reports a
// wrong-order defect as `expected undefined to be 'Let me look.'` — a message naming neither the
// index nor the block that was actually there.
function blocksOf(row: Record<string, unknown> | undefined, what: string): RawBlock[] {
  const blocks = row?.blocks;
  if (!Array.isArray(blocks)) throw new Error(`${what} carries no blocks array`);
  return blocks as RawBlock[];
}

function textAt(blocks: RawBlock[], at: number): string {
  const b = blocks[at];
  if (b?.type !== 'text' || typeof b.text !== 'string') throw new Error(`no text block at ${at}`);
  return b.text;
}

function toolAt(blocks: RawBlock[], at: number): RawBlock {
  const b = blocks[at];
  if (b?.type !== 'tool' || !b.toolCall) throw new Error(`no tool block at ${at}`);
  return b.toolCall as RawBlock;
}

describe('runChatTurn tool loop', () => {
  it('executes a requested tool then re-invokes the provider for the final answer', async () => {
    captured.length = 0;
    appended.length = 0;

    // cm:why two provider turns: the first asks for a tool, the second answers with it done
    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'forge_issues',
            arguments: '{"action":"list"}',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'chunk', text: 'You have 2 open issues.' };
          yield { type: 'done' };
        }
      },
    };

    let executedWith: { name: string; args: string } | null = null;
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async (name, argsJson) => {
        executedWith = { name, args: argsJson };
        return { content: [{ type: 'text', text: '{"items":[{"id":1},{"id":2}]}' }] };
      },
    };

    await runChatTurn({
      c: fakeCtx(),
      turn: turn(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'how many open issues?' }],
      tools,
      projectSlug: 'proj',
      userMessage: 'how many open issues?',
      userKey: 'u1',
      adapter: 'web',
    });

    expect(executedWith).toEqual({ name: 'forge_issues', args: '{"action":"list"}' });

    // cm:guard the route speaks ONE event kind and the tool round-trip is inside it, not beside it:
    // what used to be a `tool_call` frame and a `tool_result` frame is now one tool block that
    // settles (ISS-1029). The old assertion named those two frames and is replaced, not dropped.
    const kinds = new Set(captured.map((e) => e.event));
    expect([...kinds].sort()).toEqual(['conversation', 'message']);
    const entries = captured
      .filter((e) => e.event === 'message')
      .map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const toolBlocks = blocksOf(entries.at(-1), 'the final streamed entry').filter(
      (b) => b.type === 'tool',
    );
    expect(toolBlocks).toHaveLength(1);

    // cm:guard the PRE-tool assistant text is not persisted AS CONTENT: a turn that called a tool
    // and then answered is one answer, and storing the intermediate text replays it to the model as
    // a second one. It is kept in `blocks`, which nothing replays (ISS-1029).
    expect(appended).toEqual(['You have 2 open issues.']);

    const provider_called_twice = call === 2;
    expect(provider_called_twice).toBe(true);
  });

  it('finalizes immediately when no tool is requested', async () => {
    captured.length = 0;
    appended.length = 0;

    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        yield { type: 'chunk', text: 'hi' };
        yield { type: 'done' };
      },
    };

    await runChatTurn({
      c: fakeCtx(),
      turn: turn(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'hi' }],
      tools: { tools: [], execute: async () => ({ content: [] }) },
      projectSlug: 'proj',
      userMessage: 'hi',
      userKey: 'u1',
      adapter: 'web',
    });

    expect(appended).toEqual(['hi']);
    const frames = captured.filter((e) => e.event === 'message');
    expect(frames.length).toBeGreaterThan(0);
    const last = JSON.parse(frames.at(-1)?.data ?? '{}') as Record<string, unknown>;
    expect(last.content).toBe('hi');
    expect(blocksOf(last, 'the final streamed entry').every((b) => b.type === 'text')).toBe(true);
  });
});

describe('runChatTurn writes the canonical transcript entry', () => {
  /** Prose, a tool call, a failing result, more prose — the shape the whole issue is about. */
  function proseToolProse(): { provider: ChatProvider; tools: ChatToolset } {
    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield { type: 'chunk', text: 'Let me look.' };
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'forge_issues',
            arguments: '{"action":"list"}',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'chunk', text: 'That failed.' };
          yield { type: 'done' };
        }
      },
    };
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    };
    return { provider, tools };
  }

  async function run(provider: ChatProvider, tools: ChatToolset) {
    captured.length = 0;
    appended.length = 0;
    silences.length = 0;
    persisted.length = 0;
    await runChatTurn({
      c: fakeCtx(),
      turn: turn(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'how many open issues?' }],
      tools,
      projectSlug: 'proj',
      userMessage: 'how many open issues?',
      userKey: 'u1',
      adapter: 'web',
    });
  }

  it('persists the prose and the tool call as ordered blocks, the result settled onto the call', async () => {
    const { provider, tools } = proseToolProse();
    await run(provider, tools);

    const entry = persisted.at(-1);
    expect(entry, 'a turn that answered must have appended something').toBeDefined();
    const blocks = blocksOf(entry, 'the persisted entry');
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text']);
    expect(textAt(blocks, 0)).toBe('Let me look.');
    expect(textAt(blocks, 2)).toBe('That failed.');

    const tc = toolAt(blocks, 1);
    expect(tc.name).toBe('forge_issues');
    expect(tc.input).toEqual({ action: 'list' });
    expect(tc.output).toBe('boom');
    expect(tc.isError).toBe(true);
    expect(typeof tc.durationMs).toBe('number');
  });

  it('streams the canonical entry and ends on the one that was persisted', async () => {
    const { provider, tools } = proseToolProse();
    await run(provider, tools);

    const messages = captured.filter((e) => e.event === 'message');
    expect(messages.length, 'the stream carries canonical entries').toBeGreaterThan(0);

    // cm:guard the LAST `message` is the persisted entry itself, emitted after the write — that is
    // what makes "the stream and the transcript agree" an equality rather than a resemblance.
    const last = JSON.parse(messages.at(-1)?.data ?? '{}') as Record<string, unknown>;
    expect(last.type).toBe('assistant');
    expect(last.blocks).toEqual(persisted.at(-1)?.blocks);

    // The OpenAI-wire vocabulary is no longer what this route speaks.
    expect(captured.some((e) => e.event === 'chunk')).toBe(false);
    expect(captured.some((e) => e.event === 'tool_call')).toBe(false);
    expect(captured.some((e) => e.event === 'tool_result')).toBe(false);
  });

  // cm:guard ONE identity for the whole turn, growing frames and settled row alike. A client keyed
  // by `id` reduces this stream to one assistant entry; with the row minting its own, the growing
  // frames carried one id and the final frame another and a reducer showed the answer twice. Seen
  // on beta before the fix: 19 frames under `a4e93846`, the 20th under `838917e6`
  // (ISS-1029 review F1).
  it('streams every frame of a turn under the id the row is written with', async () => {
    const { provider, tools } = proseToolProse();
    await run(provider, tools);

    const ids = captured
      .filter((e) => e.event === 'message')
      .map((e) => (JSON.parse(e.data) as { id: string }).id);
    expect(ids.length).toBeGreaterThan(1);

    const rowId = persisted.at(-1)?.id;
    expect(rowId, 'the turn wrote an assistant row').toBeDefined();
    expect(new Set(ids), 'one identity across the whole turn').toEqual(new Set([rowId]));
  });

  it('keeps the tool work on a turn that ran tools and then said nothing', async () => {
    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'forge_issues',
            arguments: '{"action":"list"}',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'done' };
        }
      },
    };
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'two issues' }] }),
    };
    await run(provider, tools);

    expect(silences.length, 'an empty answer is still a silence').toBe(1);
    const blocks = persisted.at(-1)?.blocks as Array<Record<string, unknown>> | null;
    // cm:guard the tool work survives the silence: this is the ONE turn a person opens the
    // transcript to investigate, and dropping its blocks reproduces the defect here.
    expect(blocks?.some((b) => b.type === 'tool')).toBe(true);
  });

  it('keeps the tool work when the provider errors after the tool ran', async () => {
    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'forge_issues',
            arguments: '{"action":"list"}',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'error', message: 'upstream 503' };
        }
      },
    };
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'two issues' }] }),
    };
    await run(provider, tools);

    expect(silences.at(-1)).toContain('upstream 503');
    const blocks = persisted.at(-1)?.blocks as Array<Record<string, unknown>> | null;
    expect(blocks?.some((b) => b.type === 'tool')).toBe(true);
  });

  it('writes no blocks for a turn that accumulated nothing at all', async () => {
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        yield { type: 'error', message: 'upstream 503' };
      },
    };
    await run(provider, { tools: [], execute: async () => ({ content: [] }) });

    expect(silences.at(-1)).toContain('upstream 503');
    expect(persisted.at(-1)?.blocks).toBeNull();
  });
});
