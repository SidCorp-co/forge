/**
 * ISS-1091 — a private round nobody was shown is not shown by the answer path.
 *
 * Refusing to DELIVER a sensitive follow-up is not enough on its own. The round
 * is still the question's current one, and a reply arriving in the thread an
 * earlier public round opened reaches the re-post that renders the current
 * round's options — into whichever room that reply came from. That is the
 * disclosure the private destination exists to prevent, performed by the other
 * half of the lane.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const question = vi.fn<() => unknown[]>(() => []);
const deliveryRow = vi.fn<() => unknown[]>(() => []);
let selectCall = 0;
vi.mock('../../db/client.js', () => {
  const chain = {
    where: () => chain,
    limit: () => Promise.resolve(selectCall++ === 0 ? question() : deliveryRow()),
  };
  return { db: { select: () => ({ from: () => chain }) } };
});

const sent: string[] = [];
vi.mock('./outbound.js', () => ({
  FIXED_REPLY_CONSTANT: Symbol('fixed'),
  sendFixedReply: async (_t: unknown, text: string) => {
    sent.push(text);
    return { messageId: 'm' };
  },
}));

vi.mock('../../messaging/screen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../messaging/screen.js')>();
  return {
    ...actual,
    screenAtDoor: (_door: unknown, segments: readonly string[]) => actual.admitted(segments),
  };
});
vi.mock('../../messaging/contract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../messaging/contract.js')>()),
  problemsOf: () => [],
}));

const answerAs = vi.fn<() => Promise<void>>(async () => {});
vi.mock('../../questions/read.js', () => ({ answerAs: () => answerAs() }));
vi.mock('../../questions/write.js', () => ({ QuestionRefused: class extends Error {} }));
vi.mock('../../assistant/identity/directory.js', () => ({
  namespaceFromServerUrl: () => 'chat.example.co',
}));
vi.mock('../../assistant/identity/speaker-link.js', () => ({
  resolveSpeaker: async () => ({ linked: true, userId: 'u-1' }),
  unlinkedMessage: () => 'unlinked',
}));

const { handleQuestionThreadReply } = await import('./question-inbound.js');

const sensitiveChoiceRound = {
  round: 2,
  prompt: 'which credential?',
  askedAt: 'now',
  answerShape: 'choice',
  options: [
    {
      id: 'a',
      label: 'THE STAGING TOKEN',
      authority: 'writer',
      bindsTo: 'session',
      executedBy: 'agent',
    },
    {
      id: 'b',
      label: 'THE PRODUCTION TOKEN',
      authority: 'admin',
      bindsTo: 'session',
      executedBy: 'agent',
    },
  ],
  recommendedOptionId: 'a',
  sensitive: true,
};

const reply = (text: string) =>
  handleQuestionThreadReply({
    questionId: 'q-1',
    serverUrl: 'https://chat.example.co',
    m: { id: 'm-1', rid: 'ROOMA', tmid: 'root', text, userId: 'rc-1', username: 'dao' } as never,
    transport: {
      kind: 'rest',
      auth: { serverUrl: 'x', authToken: 'y', userId: 'z' },
      rid: 'ROOMA',
    },
  });

beforeEach(() => {
  selectCall = 0;
  sent.length = 0;
  answerAs.mockClear();
  question.mockReturnValue([
    {
      id: 'q-1',
      steps: [
        { round: 1, prompt: 'p', askedAt: 'now', answerShape: 'free_text', needed: 'x' },
        sensitiveChoiceRound,
      ],
    },
  ]);
});

describe('a private round that was never delivered', () => {
  it('renders none of its material into the thread a public round opened', async () => {
    deliveryRow.mockReturnValue([{ status: 'undeliverable' }]);
    await reply('what are the options again?');
    expect(sent.join('\n')).not.toContain('STAGING TOKEN');
    expect(sent.join('\n')).not.toContain('PRODUCTION TOKEN');
    expect(sent.join('\n')).not.toContain('which credential?');
  });

  it('says why, rather than going quiet', async () => {
    deliveryRow.mockReturnValue([{ status: 'undeliverable' }]);
    await reply('what are the options again?');
    expect(sent.join('\n')).toContain('private');
  });

  it('accepts no answer for it', async () => {
    deliveryRow.mockReturnValue([{ status: 'undeliverable' }]);
    await reply('2-1');
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('serves the round normally once it HAS been delivered', async () => {
    deliveryRow.mockReturnValue([{ status: 'delivered' }]);
    await reply('2-1');
    expect(answerAs).toHaveBeenCalled();
  });
});
