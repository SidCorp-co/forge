import { describe, expect, it, vi } from 'vitest';

// cm:why the module boundaries are mocked so this file exercises the glue — resolve, open the turn,
// drain, persist, reply — rather than the store or the provider.
const appended: string[] = [];
const silences: string[] = [];
vi.mock('./conversation-turn.js', () => ({
  openTurn: async (o: { adapter: string }) => ({
    conversationId: 'conv-1',
    adapter: o.adapter,
    history: [] as unknown[],
    pending: [] as unknown[],
  }),
  appendUserMessage: (
    t: { pending: unknown[] },
    c: string,
    opts: { images?: unknown[] } = {},
  ) => {
    const images = opts.images ?? [];
    t.pending.push({ role: 'user', content: c, images });
  },
  appendAssistantMessage: (t: { pending: unknown[] }, c: string) => {
    appended.push(c);
    t.pending.push({ role: 'assistant', content: c, images: [] });
  },
  appendSilence: (t: { pending: unknown[] }, reason: string) => {
    silences.push(reason);
    t.pending.push({ role: 'assistant', content: '', images: [], silenceReason: reason });
  },
  persistMessages: async () => undefined,
  toProviderMessages: (
    t: {
      history: Array<{ role: string; content: string; images?: Array<{ ref: string }> }>;
      pending: Array<{ role: string; content: string; images?: Array<{ ref: string }> }>;
    },
    resolved?: Map<string, string>,
  ) =>
    [...t.history, ...t.pending].map((m) => {
      const url = m.images?.[0] ? resolved?.get(m.images[0].ref) : undefined;
      return url
        ? {
            role: m.role,
            content: [
              { type: 'text', text: m.content },
              { type: 'image_url', image_url: { url } },
            ],
          }
        : { role: m.role, content: m.content };
    }),
}));

vi.mock('./providers/bootstrap.js', () => ({ defaultChatProviderId: () => 'mock' }));
vi.mock('../config/env.js', () => ({ env: { CHAT_CONTEXT_BUDGET_TOKENS: 80_000 } }));
const buildSystemPromptCalls: Array<Record<string, unknown>> = [];
vi.mock('./system-prompt.js', () => ({
  buildSystemPrompt: (input: Record<string, unknown>) => {
    buildSystemPromptCalls.push(input);
    return 'SYS';
  },
}));

const fakeProgress = {
  done: 54,
  inFlight: 7,
  remaining: 3,
  total: 64,
  byStatus: {},
  computedAt: new Date(),
};
vi.mock('../issues/progress.js', () => ({
  computeProjectProgress: async () => fakeProgress,
  buildProgressFactsBlock: () => 'PROGRESS FACTS BLOCK',
}));

const seenRequests: Array<{ messages: unknown[] }> = [];
const mockProvider = {
  id: 'mock',
  defaultModel: 'm',
  async *stream(req: { messages: unknown[] }) {
    seenRequests.push({ messages: req.messages });
    yield { type: 'chunk' as const, text: 'The answer is 42.' };
    yield { type: 'done' as const };
  },
};
vi.mock('./providers/registry.js', () => ({
  resolveForProject: async () => ({ provider: mockProvider, model: 'm' }),
}));

// Fake db: two selects (project, then appConfig) + a chat_logs insert.
let selectCall = 0;
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          selectCall++;
          return selectCall === 1
            ? [{ id: 'p1', slug: 'proj', name: 'Proj', agentConfig: null }]
            : [];
        },
      }),
    }),
  }),
  insert: () => ({ values: async () => undefined }),
};
vi.mock('../db/client.js', () => ({ db: fakeDb }));

const { runExternalChatTurn } = await import('./external-chat.js');

describe('runExternalChatTurn', () => {
  it('resolves, runs the turn, returns the reply, and persists the final text', async () => {
    appended.length = 0;
    selectCall = 0;
    buildSystemPromptCalls.length = 0;
    const out = await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'what is the answer?',
      userId: null,
    });
    expect(out.conversationId).toBe('conv-1');
    expect(out.reply).toBe('The answer is 42.');
    expect(out.terminal).toBe('done');
    expect(appended).toEqual(['The answer is 42.']);
  });

  it('injects the progress facts block into the system prompt and returns the snapshot', async () => {
    buildSystemPromptCalls.length = 0;
    selectCall = 0;
    const out = await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'how is the project progressing?',
      userId: null,
    });
    expect(buildSystemPromptCalls[0]?.progressFacts).toBe('PROGRESS FACTS BLOCK');
    expect(out.progress).toEqual(fakeProgress);
  });
});

describe('runExternalChatTurn — images', () => {
  const IMAGE = {
    name: 's.png',
    mime: 'image/png',
    ref: 'https://chat.example.com/file-upload/a/s.png',
    dataBase64: 'QUJD',
  };

  it("sends this turn's image to the model as a content part", async () => {
    seenRequests.length = 0;
    selectCall = 0;
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'what is wrong here?',
      images: [IMAGE],
      userId: null,
    });
    expect(seenRequests[0]?.messages).toContainEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is wrong here?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    });
  });

  it('sends a plain string turn when the message carried no image', async () => {
    seenRequests.length = 0;
    selectCall = 0;
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'plain question',
      userId: null,
    });
    expect(seenRequests[0]?.messages).toContainEqual({
      role: 'user',
      content: 'plain question',
    });
  });
});

describe('runExternalChatTurn — turn context placement', () => {
  it('puts the conversation seed on the newest user message, never in the system prompt', async () => {
    selectCall = 0;
    seenRequests.length = 0;
    buildSystemPromptCalls.length = 0;
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'what broke?',
      conversationContext: '[an]: deploy is failing',
    });
    const messages = seenRequests[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toContain('[an]: deploy is failing');
    expect(messages.at(-1)?.content).toMatch(/---\n\nwhat broke\?$/);
    expect(buildSystemPromptCalls[0]).not.toHaveProperty('conversationContext');
  });
});
