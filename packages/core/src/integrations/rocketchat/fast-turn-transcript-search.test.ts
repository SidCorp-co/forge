/**
 * ISS-1090 — the room's transcript search reaches a Rocket.Chat turn beside
 * `rocketchat_history`, and the seed context is not touched on the way.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatToolset } from '../../assistant/tools/mcp-adapter.js';

const stub = (name: string): ChatToolset => ({
  tools: [
    {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
  ],
  execute: async () => ({ content: [] }),
});

vi.mock('../../assistant/tools/registry.js', () => ({
  buildProjectToolset: () => stub('forge_issues'),
}));
vi.mock('../../assistant/tools/escalate.js', () => ({
  buildEscalationToolset: () => stub('escalate'),
  ESCALATE_TOOL_NAME: 'escalate',
}));
vi.mock('../../assistant/tools/principal.js', () => ({ buildChatToolContext: () => ({}) }));
vi.mock('../../assistant/tools/turn-images.js', () => ({
  withTurnImages: (set: ChatToolset) => set,
}));
const permalinkMock = vi.fn(async (_a: unknown, rid: string, id: string) => `link:${rid}:${id}`);
vi.mock('./rest-client.js', () => ({
  buildMessagePermalink: (a: unknown, rid: string, id: string) => permalinkMock(a, rid, id),
  fetchAttachmentBytes: async () => null,
  fetchRoomHistory: async () => [],
  fetchMessage: async () => null,
  fetchMessagesBeside: async () => [],
  fetchThreadMessages: async () => [],
}));
const searchMock = vi.fn(async (_args: Record<string, unknown>) => ({
  conversationId: 'c1',
  query: 'q',
  matches: [],
  coverage: { indexedThroughSeq: 0, indexedThroughAt: null, latestSeq: 0, messagesBeyondIndex: 0 },
  limitation: null,
}));
vi.mock('../../conversations/transcript-search.js', async () => {
  const actual = await vi.importActual<typeof import('../../conversations/transcript-search.js')>(
    '../../conversations/transcript-search.js',
  );
  return { ...actual, searchConversationTranscript: (a: unknown) => searchMock(a as never) };
});

const { prepareFastTurn } = await import('./images.js');
const toolModule = await import('../../conversations/transcript-search-tool.js');
const TRANSCRIPT_SEARCH_TOOL_NAME = toolModule.TRANSCRIPT_SEARCH_TOOL_NAME;
const context = await import('./context.js');

const auth = { baseUrl: 'https://chat.example', userId: 'bot', authToken: 't' } as never;

function opts(overrides: Record<string, unknown> = {}) {
  return {
    route: { projectId: 'p1', projectSlug: 'proj' },
    principalUserId: 'u1',
    turn: { conversationId: 'c1', speakerUserId: 'u1', handleUserId: 'h1' },
    restAuth: auth,
    rid: 'RID',
    images: [],
    externalToolsets: [],
    ...overrides,
  } as Parameters<typeof prepareFastTurn>[0];
}

describe('prepareFastTurn', () => {
  it('offers the transcript search beside rocketchat_history and the quote tool', async () => {
    const inputs = await prepareFastTurn(opts());
    expect(inputs.tools.tools.map((t) => t.function.name)).toEqual(
      expect.arrayContaining([
        'rocketchat_history',
        context.QUOTE_CONTEXT_TOOL_NAME,
        TRANSCRIPT_SEARCH_TOOL_NAME,
      ]),
    );
  });

  it('offers no transcript search where the turn names no conversation', async () => {
    const inputs = await prepareFastTurn(
      opts({ turn: { conversationId: null, speakerUserId: null, handleUserId: null } }),
    );
    expect(inputs.tools.tools.map((t) => t.function.name)).not.toContain(
      TRANSCRIPT_SEARCH_TOOL_NAME,
    );
    expect(inputs.tools.tools.map((t) => t.function.name)).toContain('rocketchat_history');
  });

  it('runs the search under the turn conversation and the turn principal', async () => {
    searchMock.mockClear();
    const inputs = await prepareFastTurn(opts());
    await inputs.tools.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"ladder"}');
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', userId: 'u1' }),
    );
  });

  it('tells a threaded turn that the surrounding channel is not in this conversation', async () => {
    searchMock.mockClear();
    const inputs = await prepareFastTurn(opts({ tmid: 'TMID' }));
    await inputs.tools.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"ladder"}');
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueLimitation: expect.stringContaining('only the thread this message is in'),
      }),
    );
  });

  it('says nothing about a thread for a turn in the channel itself', async () => {
    searchMock.mockClear();
    const inputs = await prepareFastTurn(opts());
    await inputs.tools.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"ladder"}');
    expect(searchMock.mock.calls.at(0)?.at(0)).not.toHaveProperty('venueLimitation');
  });

  it('takes no existing tool name over, so the two older readers still answer', async () => {
    // `mergeToolsets` routes by name and the FIRST owner wins, so a new tool sharing a
    // name would silently replace the reader it sits beside rather than adding to it.
    const inputs = await prepareFastTurn(opts());
    const names = inputs.tools.tools.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
    const history = await inputs.tools.execute('rocketchat_history', '{}');
    expect(JSON.stringify(history)).not.toContain('unknown tool');
    const quote = await inputs.tools.execute(context.QUOTE_CONTEXT_TOOL_NAME, '{}');
    expect(JSON.stringify(quote)).not.toContain('unknown tool');
  });
});
