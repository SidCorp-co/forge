import { describe, expect, it, vi } from 'vitest';

// Mock the module boundaries so the test exercises external-chat's glue
// (resolve → session → drain loop → persist → return reply) without a DB.
const appended: string[] = [];
vi.mock('./session.js', () => ({
  loadOrCreateSession: async (o: { projectId: string; source: string; userId: string | null }) => ({
    id: 'sess-1',
    projectId: o.projectId,
    userId: o.userId,
    source: o.source,
    messages: [] as unknown[],
  }),
  appendUserMessage: (s: { messages: unknown[] }, c: string) =>
    s.messages.push({ role: 'user', content: c }),
  appendAssistantMessage: (s: { messages: unknown[] }, c: string) => {
    appended.push(c);
    s.messages.push({ role: 'assistant', content: c });
  },
  persistMessages: async () => undefined,
  toProviderMessages: (s: { messages: Array<{ role: string; content: string }> }) => s.messages,
}));

vi.mock('./providers/bootstrap.js', () => ({ defaultChatProviderId: () => 'mock' }));
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

const mockProvider = {
  id: 'mock',
  defaultModel: 'm',
  async *stream() {
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
      source: 'rocketchat',
      message: 'what is the answer?',
      userId: null,
    });
    expect(out.sessionId).toBe('sess-1');
    expect(out.reply).toBe('The answer is 42.');
    expect(out.terminal).toBe('done');
    expect(appended).toEqual(['The answer is 42.']);
  });

  it('injects the progress facts block into the system prompt and returns the snapshot', async () => {
    buildSystemPromptCalls.length = 0;
    selectCall = 0;
    const out = await runExternalChatTurn({
      projectId: 'p1',
      source: 'rocketchat',
      message: 'how is the project progressing?',
      userId: null,
    });
    expect(buildSystemPromptCalls[0]?.progressFacts).toBe('PROGRESS FACTS BLOCK');
    expect(out.progress).toEqual(fakeProgress);
  });
});
