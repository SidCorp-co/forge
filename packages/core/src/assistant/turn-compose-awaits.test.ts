// ISS-277: a reply waits on the person only when the attempt whose text is delivered called
// `await_reply` and that text is the model's own. The text itself is never read for a question.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Attempt {
  reply: string;
  ask: boolean;
}

const script: { attempts: Attempt[]; screen: 'pass' | 'fallback' | 'retry-pass' } = {
  attempts: [],
  screen: 'pass',
};
const offered: string[][] = [];

vi.mock('../conversations/index.js', async () => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    confidentLanguageOf: replies.confidentLanguageOf,
    codeAuthored: (text: string) => ({ text, proof: null }),
    recordSilence: async () => undefined,
    turnFailureReason: replies.turnFailureReason,
  };
});
vi.mock('../lib/data-egress.js', () => ({ egressDeep: async () => ({ ok: true, value: null }) }));
vi.mock('./confab.js', () => ({ correctFalseClaims: (text: string) => ({ text }) }));
vi.mock('../credentials/turn-credential.js', () => ({ turnAuthorityRefusalOf: () => null }));
vi.mock('./external-chat.js', () => ({
  runExternalChatTurn: async (args: {
    tools?: {
      tools: { function: { name: string } }[];
      execute: (n: string, a: string) => Promise<unknown>;
    };
  }) => {
    const attempt = script.attempts.shift();
    if (!attempt) throw new Error('the test scripted no further attempt');
    offered.push(args.tools?.tools.map((t) => t.function.name) ?? []);
    if (attempt.ask) await args.tools?.execute('await_reply', '{}');
    return {
      conversationId: 'c-1',
      reply: attempt.reply,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: attempt.ask ? [{ name: 'await_reply', arguments: '{}' }] : [],
      progress: null,
    };
  },
}));
vi.mock('./screened-reply.js', () => ({
  declinedTail: () => '',
  declinedTurn: () => false,
  screenedTurnReply: async (args: {
    first: { reply: string };
    retry: (instruction: string) => Promise<{ reply: string }>;
  }) => {
    if (script.screen === 'fallback') return { text: 'I could not check that reply.', proof: null };
    if (script.screen === 'retry-pass') {
      const again = await args.retry('rewrite it');
      return { text: again.reply, proof: { door: 'web-chat-reply' } };
    }
    return { text: args.first.reply, proof: { door: 'web-chat-reply' } };
  },
}));

const { composeReply } = await import('./turn-compose.js');

function ctx(recordsAsks: boolean) {
  return {
    req: {
      venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
      authority: { userId: 'u-1', origin: 'message' },
      handleName: 'catalog-api',
      door: 'web-chat-reply',
      message: 'draft REQ-1',
      mayDecline: true,
      sendMode: 'reply',
      questionAlreadyRecorded: true,
      ...(recordsAsks ? { recordsAsks: true } : {}),
    },
    conversationId: 'c-1',
    abort: new AbortController(),
    setPhase: () => undefined,
    credential: async () => {
      throw new Error('no token in this test');
    },
  } as never;
}

beforeEach(() => {
  script.attempts = [];
  script.screen = 'pass';
  offered.length = 0;
});

describe('a reply is recorded as awaiting an answer only on the record of its own turn', () => {
  it('awaits when the attempt called await_reply and its own text is delivered', async () => {
    script.attempts = [{ reply: 'I drafted REQ-1. Please confirm.', ask: true }];
    const reply = await composeReply(ctx(true));
    expect(reply).toMatchObject({ send: true, awaitsReply: true });
    expect(offered[0]).toContain('await_reply');
  });

  it('does not await when the model ended on a question but never called the tool', async () => {
    script.attempts = [
      { reply: 'Why did the deploy fail?\n\n- The token had expired.', ask: false },
    ];
    expect(await composeReply(ctx(true))).toMatchObject({ send: true, awaitsReply: false });
  });

  it('does not await when the screen replaced the reply with a code-authored line', async () => {
    script.attempts = [{ reply: 'Shall I file REQ-1?', ask: true }];
    script.screen = 'fallback';
    expect(await composeReply(ctx(true))).toMatchObject({ send: true, awaitsReply: false });
  });

  it("reads the retried attempt's own call, since its text is the one delivered", async () => {
    script.attempts = [
      { reply: 'Shall I file REQ-1?', ask: true },
      { reply: 'REQ-1 is filed.', ask: false },
    ];
    script.screen = 'retry-pass';
    expect(await composeReply(ctx(true))).toMatchObject({ send: true, awaitsReply: false });
    expect(offered[1]).toContain('await_reply');

    script.attempts = [
      { reply: 'REQ-1 is drafted.', ask: false },
      { reply: 'REQ-1 is drafted. Shall I file it?', ask: true },
    ];
    script.screen = 'retry-pass';
    expect(await composeReply(ctx(true))).toMatchObject({ send: true, awaitsReply: true });
  });

  it('offers no await_reply to a venue that does not record asks, and records none', async () => {
    script.attempts = [{ reply: 'Shall I file REQ-1?', ask: false }];
    expect(await composeReply(ctx(false))).toMatchObject({ send: true, awaitsReply: false });
    expect(offered[0]).not.toContain('await_reply');
  });
});
