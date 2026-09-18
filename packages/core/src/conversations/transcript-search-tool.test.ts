import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '../mcp/tool-result.js';

const searchMock = vi.fn();
vi.mock('./transcript-search.js', async () => {
  const actual =
    await vi.importActual<typeof import('./transcript-search.js')>('./transcript-search.js');
  return { ...actual, searchConversationTranscript: (a: unknown) => searchMock(a) };
});

const {
  buildTranscriptSearchToolset,
  SEARCH_MAX_CALLS_PER_TURN,
  SEARCH_QUERY_CAP,
  TRANSCRIPT_SEARCH_TOOL_NAME,
} = await import('./transcript-search-tool.js');

const ROOM = '11111111-1111-4111-8111-111111111111';

const emptyResult = {
  conversationId: ROOM,
  query: 'q',
  matches: [],
  coverage: { indexedThroughSeq: 3, indexedThroughAt: null, latestSeq: 3, messagesBeyondIndex: 0 },
  limitation: null,
};

function read(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first && 'text' in first && typeof first.text === 'string' ? first.text : '{}';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue(emptyResult);
});

describe('buildTranscriptSearchToolset', () => {
  it('offers exactly one tool and refuses any other name', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    expect(set.tools.map((t) => t.function.name)).toEqual([TRANSCRIPT_SEARCH_TOOL_NAME]);
    const out = read(await set.execute('rocketchat_history', '{}'));
    expect(out.isError).toBe(true);
    expect(out.body.error).toContain('unknown tool');
  });

  it('never lets the model name the room or the caller — neither is a parameter', () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    const params = set.tools[0]?.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties).sort()).toEqual(['limit', 'query']);
  });

  it('passes the closed-over room and caller to the search, whatever the model sent', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    await set.execute(
      TRANSCRIPT_SEARCH_TOOL_NAME,
      JSON.stringify({ query: 'retry ladder', conversationId: 'somebody-elses', userId: 'u2' }),
    );
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: ROOM, userId: 'u1', query: 'retry ladder' }),
    );
  });

  it('spends the per-turn call budget in core and refuses the call past it by name', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    for (let i = 0; i < SEARCH_MAX_CALLS_PER_TURN; i += 1) {
      const ok = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"x"}'));
      expect(ok.isError).toBe(false);
    }
    const over = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"x"}'));
    expect(over.isError).toBe(true);
    expect(over.body.error).toContain(`capped at ${SEARCH_MAX_CALLS_PER_TURN} calls per turn`);
    expect(searchMock).toHaveBeenCalledTimes(SEARCH_MAX_CALLS_PER_TURN);
  });

  it('counts a refused call against the budget, so a bad argument cannot buy an extra turn', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    for (let i = 0; i < SEARCH_MAX_CALLS_PER_TURN; i += 1) {
      await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{}');
    }
    const over = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"x"}'));
    expect(over.body.error).toContain('capped at');
  });

  it('refuses arguments that are not a JSON object rather than throwing out of the tool', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    expect(read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, 'null')).body.error).toBe(
      'arguments were not a JSON object',
    );
    expect(read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{oops')).body.error).toBe(
      'arguments were not valid JSON',
    );
  });

  it('refuses an over-long query by name instead of cutting it into a different question', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    const out = read(
      await set.execute(
        TRANSCRIPT_SEARCH_TOOL_NAME,
        JSON.stringify({ query: 'q'.repeat(SEARCH_QUERY_CAP + 1) }),
      ),
    );
    expect(out.isError).toBe(true);
    expect(out.body.error).toContain(`at most ${SEARCH_QUERY_CAP} characters`);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('hands the search the number the caller asked for, so the clamp is reported rather than hidden here', async () => {
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u1' });
    await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, JSON.stringify({ query: 'x', limit: 999 }));
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 999 }));
  });

  it("returns the room fence's own refusal, never an empty result set", async () => {
    searchMock.mockRejectedValue(
      new HTTPException(403, {
        message: 'conversation X is about project P and you hold no viewer role on it',
        cause: { code: 'CONVERSATION_OUT_OF_SCOPE' },
      }),
    );
    const set = buildTranscriptSearchToolset({ conversationId: ROOM, principalUserId: 'u2' });
    const out = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"x"}'));
    expect(out.isError).toBe(true);
    expect(out.body.error).toContain('you hold no viewer role on it');
    expect(out.body).not.toHaveProperty('matches');
  });

  it('attaches a link per source the venue can address, and leaves the rest without one', async () => {
    searchMock.mockResolvedValue({
      ...emptyResult,
      matches: [
        {
          passageId: 'p1',
          firstSeq: 0,
          lastSeq: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          text: '[ana]: hi',
          truncated: false,
          stillOpen: false,
          sources: [
            { messageId: 'm1', seq: 0, at: 'x', author: 'ana', externalId: 'rc1' },
            { messageId: 'm2', seq: 1, at: 'x', author: 'ana', externalId: null },
          ],
        },
      ],
      limitation: 'message(s) m2 carry no usable transport id',
    });
    const set = buildTranscriptSearchToolset({
      conversationId: ROOM,
      principalUserId: 'u1',
      permalink: async (id) => `https://chat.example/msg/${id}`,
    });
    const out = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"hi"}'));
    const sources = (out.body.matches as Array<{ sources: Array<Record<string, unknown>> }>)[0]
      ?.sources;
    expect(sources?.[0]?.link).toBe('https://chat.example/msg/rc1');
    expect(sources?.[1]).not.toHaveProperty('link');
    expect(out.body.limitation).toContain('m2');
  });

  it('drops a link the venue could not build rather than failing the whole call', async () => {
    searchMock.mockResolvedValue({
      ...emptyResult,
      matches: [
        {
          passageId: 'p1',
          firstSeq: 0,
          lastSeq: 0,
          startedAt: 'x',
          endedAt: 'x',
          text: 't',
          truncated: false,
          stillOpen: false,
          sources: [{ messageId: 'm1', seq: 0, at: 'x', author: null, externalId: 'rc1' }],
        },
      ],
    });
    const set = buildTranscriptSearchToolset({
      conversationId: ROOM,
      principalUserId: 'u1',
      permalink: async () => {
        throw new Error('rooms.info refused');
      },
    });
    const out = read(await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"hi"}'));
    expect(out.isError).toBe(false);
    const sources = (out.body.matches as Array<{ sources: Array<Record<string, unknown>> }>)[0]
      ?.sources;
    expect(sources?.[0]).not.toHaveProperty('link');
  });

  it("carries the venue's own limitation into the search, so a thread says what it does not cover", async () => {
    const set = buildTranscriptSearchToolset({
      conversationId: ROOM,
      principalUserId: 'u1',
      venueLimitation: 'this search covers only the thread this message is in',
    });
    await set.execute(TRANSCRIPT_SEARCH_TOOL_NAME, '{"query":"x"}');
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueLimitation: 'this search covers only the thread this message is in',
      }),
    );
  });
});
