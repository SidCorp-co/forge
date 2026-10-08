// A screen rewrite is the same turn asked again. Production, 2026-07-17 (chat mining, 2026-10-07):
// one ask in a group room filed a record, the reply promised a follow-up, the screen refused it as
// a future promise, and the rewrite filed the same record again — twice per ask, four in 32 s.
// The model is scripted here exactly as it behaved: every attempt records, then names what it made.
// A chat records Feedback, never an issue (owner ruling 2026-10-08), so the filing is forge_feedback.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnBlockStage } from './turn-stage.js';

const TITLE = 'Push the draft issues through review';
const FILING = JSON.stringify({
  kind: 'change_request',
  title: TITLE,
  body: 'Several issues are still drafts and nobody has reviewed them.',
  screen: '/projects/hop/issues',
});

const tracker = { filed: 0 };
const asked: string[] = [];
const screenSaw: { name: string }[][] = [];

vi.mock('../conversations/index.js', async () => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    ...replies,
    screened: (text: string) => ({ text, proof: null }),
    codeAuthored: (text: string) => ({ text, proof: null }),
    recordSilence: async () => undefined,
  };
});
vi.mock('../lib/data-egress.js', () => ({ egressDeep: async () => ({ ok: true, value: null }) }));
vi.mock('./confab.js', () => ({ correctFalseClaims: (text: string) => ({ text }) }));
vi.mock('../credentials/turn-credential.js', () => ({ turnAuthorityRefusalOf: () => null }));
vi.mock('./external-chat.js', () => ({
  runExternalChatTurn: async (args: {
    message: string;
    tools?: { execute: (n: string, a: string) => Promise<{ content: { text: string }[] }> };
  }) => {
    asked.push(args.message);
    const result = await args.tools?.execute('forge_feedback', FILING);
    const said = result?.content.map((b) => b.text).join('\n') ?? '';
    const key = /FB-\d+/.exec(said)?.[0] ?? 'nothing';
    return {
      conversationId: 'c-1',
      reply:
        asked.length === 1
          ? `Filed ${key}. I will update you when it moves.`
          : `Filed ${key}; it is in the tracker now.`,
      terminal: 'done',
      error: null,
      iterations: 2,
      toolCalls: [{ name: 'forge_feedback', arguments: FILING }],
      progress: null,
    };
  },
}));
vi.mock('./screened-reply.js', () => ({
  declinedTail: () => '',
  declinedTurn: () => false,
  screenedTurnReply: async (args: {
    first: { reply: string; toolCalls: { name: string }[] };
    retry: (instruction: string) => Promise<{ reply: string; toolCalls: { name: string }[] }>;
  }) => {
    screenSaw.push(args.first.toolCalls);
    const again = await args.retry(
      '[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: reply promises a future action but there is no follow-up turn — do the work now and report the result. Rewrite it now, actually CALL the tools if work is needed.',
    );
    screenSaw.push(again.toolCalls);
    return { text: again.reply, proof: { door: 'rocketchat-reply' } };
  },
}));

const { composeReply } = await import('./turn-compose.js');

const trackerTools = {
  tools: [
    { type: 'function', function: { name: 'forge_feedback', description: '', parameters: {} } },
  ],
  ranAs: () => 'u-1',
  async execute(name: string) {
    if (name !== 'forge_feedback') throw new Error('the test scripted only a feedback filing');
    tracker.filed += 1;
    const key = `FB-${60 + tracker.filed}`;
    return { content: [{ type: 'text', text: JSON.stringify({ feedback: { key } }) }] };
  },
};

function ctx() {
  return {
    req: {
      venue: { adapter: 'rocketchat', externalId: 'room-1', shape: 'group', projectId: 'p-1' },
      authority: { userId: 'u-1', origin: 'message' },
      handleName: 'helper',
      door: 'rocketchat-reply',
      message: '@helper yes, file a request to push the drafts along',
      mayDecline: true,
      sendMode: 'reply',
      questionAlreadyRecorded: true,
      prepare: async () => ({ tools: trackerTools }),
    },
    conversationId: 'c-1',
    abort: new AbortController(),
    setPhase: () => undefined,
    draft: { text: '' },
    stage: new TurnBlockStage(),
    credential: async () => {
      throw new Error('no token in this test');
    },
  } as never;
}

beforeEach(() => {
  tracker.filed = 0;
  asked.length = 0;
  screenSaw.length = 0;
});

describe('a screen rewrite does not repeat what the first attempt already did', () => {
  it('records the feedback once and delivers the item the first attempt recorded', async () => {
    const reply = await composeReply(ctx());
    expect(tracker.filed).toBe(1);
    expect(reply).toMatchObject({
      send: true,
      message: { text: 'Filed FB-61; it is in the tracker now.' },
    });
  });

  it('tells the rewrite what the first attempt did, the item it recorded included', async () => {
    await composeReply(ctx());
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('What this turn already did before this rewrite');
    expect(asked[1]).toContain(TITLE);
    expect(asked[1]).toContain('FB-61');
  });

  it("screens the rewrite against every call the turn made, the first attempt's included", async () => {
    await composeReply(ctx());
    expect(screenSaw[1]).toHaveLength(2);
  });
});
