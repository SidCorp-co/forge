import { describe, expect, it, vi } from 'vitest';

const appended: string[] = [];
const silences: string[] = [];
/** One entry per persistMessages call: `role:content`, or `role:!reason` for a silence. */
const persisted: string[][] = [];
vi.mock('./conversation-turn.js', () => ({
  openTurn: async (o: { adapter: string }) => ({
    conversationId: 'conv-1',
    adapter: o.adapter,
    history: [] as unknown[],
    pending: [] as unknown[],
  }),
  appendUserMessage: (t: { pending: unknown[] }, c: string, opts: { images?: unknown[] } = {}) => {
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
  persistMessages: async (t: {
    pending: Array<{ role: string; content: string; silenceReason?: string }>;
  }) => {
    const written = t.pending.splice(0).map((m, i) => ({ ...m, id: `msg-${i}` }));
    persisted.push(
      written.map((m) => `${m.role}:${m.silenceReason ? `!${m.silenceReason}` : m.content}`),
    );
    return written;
  },
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

/** What the turn is told about who it speaks as and to; each case sets it. */
const turnSelf: { self: unknown; speakerContext: string | null } = {
  self: null,
  speakerContext: null,
};
const loadTurnSelfCalls: Array<Record<string, unknown>> = [];
vi.mock('./turn-self.js', () => ({
  loadTurnSelf: async (input: Record<string, unknown>) => {
    loadTurnSelfCalls.push(input);
    return { self: turnSelf.self, speakerContext: turnSelf.speakerContext };
  },
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
/** What the provider answers this turn; empty is a turn that produced nothing. */
let replyText = 'The answer is 42.';

const mockProvider = {
  id: 'mock',
  defaultModel: 'm',
  async *stream(req: { messages: unknown[] }) {
    seenRequests.push({ messages: req.messages });
    if (replyText) yield { type: 'chunk' as const, text: replyText };
    yield { type: 'done' as const };
  },
};
vi.mock('./providers/registry.js', () => ({
  resolveForProject: async () => ({ provider: mockProvider, model: 'm' }),
}));

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

describe('runExternalChatTurn — what a turn writes to the room it reads', () => {
  const base = {
    projectId: 'p1',
    adapter: 'rocketchat' as const,
    conversationId: 'conv-1',
    userId: 'u-1',
  };

  it('writes the question and not the answer under `question-only`, and names no row to stamp', async () => {
    persisted.length = 0;
    selectCall = 0;
    const out = await runExternalChatTurn({ ...base, message: 'asked', record: 'question-only' });
    expect(persisted).toEqual([['user:asked']]);
    expect(out.assistantMessageId).toBeNull();
    expect(out.reply).toBe('The answer is 42.');
  });

  it('writes nothing at all under `nothing`, so a corrective retry files no words the speaker never said', async () => {
    persisted.length = 0;
    selectCall = 0;
    const out = await runExternalChatTurn({
      ...base,
      message: '[SYSTEM CHECK] rewrite it',
      record: 'nothing',
    });
    expect(persisted).toEqual([]);
    expect(out.assistantMessageId).toBeNull();
  });

  it('still writes the silence under `question-only`, because nothing replaces it', async () => {
    persisted.length = 0;
    selectCall = 0;
    replyText = '';
    try {
      await runExternalChatTurn({ ...base, message: 'asked', record: 'question-only' });
    } finally {
      replyText = 'The answer is 42.';
    }
    expect(persisted).toEqual([['user:asked', 'assistant:!empty-reply']]);
  });

  it('writes the question AND the answer when nothing says otherwise', async () => {
    persisted.length = 0;
    selectCall = 0;
    await runExternalChatTurn({ ...base, message: 'asked' });
    expect(persisted).toEqual([['user:asked', 'assistant:The answer is 42.']]);
  });
});

describe('runExternalChatTurn — who the turn speaks as, and to', () => {
  const reset = () => {
    selectCall = 0;
    seenRequests.length = 0;
    buildSystemPromptCalls.length = 0;
    loadTurnSelfCalls.length = 0;
    turnSelf.self = null;
    turnSelf.speakerContext = null;
  };

  it('hands the linked speaker, not the principal, to the self read, and puts the style line on the newest user message', async () => {
    reset();
    turnSelf.speakerContext = 'Reply style for the person you are answering: concise — short.';
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'status?',
      userId: 'principal-1',
      userKey: 'thanh',
      speakerUserId: 'speaker-1',
    });
    expect(loadTurnSelfCalls[0]).toMatchObject({
      speakerUserId: 'speaker-1',
      speakerLabel: 'thanh',
      handleUserId: null,
    });
    const messages = seenRequests[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toContain(
      'Reply style for the person you are answering: concise',
    );
    expect(messages.at(-1)?.content).toMatch(/---\n\nstatus\?$/);
  });

  it('keeps an explicit null speaker null and lets the unlinked sentence ride the newest user message', async () => {
    reset();
    turnSelf.speakerContext =
      'Speaker: the newest message is from guest.42, who is not linked to a Forge user.';
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'hello',
      userId: 'principal-1',
      userKey: 'guest.42',
      speakerUserId: null,
      speakerLabel: 'guest.42',
    });
    expect(loadTurnSelfCalls[0]).toMatchObject({ speakerUserId: null, speakerLabel: 'guest.42' });
    const messages = seenRequests[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain('not linked to a Forge user');
    expect(buildSystemPromptCalls[0]).not.toHaveProperty('speakerContext');
  });

  it('treats an absent speaker as the principal speaking, and hands the self to the system prompt', async () => {
    reset();
    turnSelf.self = { soul: 'I am Babo.', instructions: null, presence: {} };
    await runExternalChatTurn({
      projectId: 'p1',
      adapter: 'rocketchat' as const,
      conversationId: 'conv-1',
      message: 'hello',
      userId: 'principal-1',
    });
    expect(loadTurnSelfCalls[0]).toMatchObject({ speakerUserId: 'principal-1' });
    expect(buildSystemPromptCalls[0]?.self).toEqual(turnSelf.self);
  });
});
