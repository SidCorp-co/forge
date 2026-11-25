// ISS-1451, ISS-1442 (FB-841, FB-852, FB-853): the language a reply is written in is read to be
// LOGGED, never to refuse or rewrite it. Three rounds tuned the guess as a refusal and failed live.
// The asks are the production ones, anonymised.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../messaging/gather.js', async () => {
  const { NO_FACTS } = await import('../messaging/facts.js');
  return { gatherFacts: async () => NO_FACTS };
});

import { confidentLanguageOf } from '../conversations/text-language.js';
import { screenedTurnReply as screenedTurn } from './screened-reply.js';

const turn = (reply: string) => ({
  conversationId: 'c-1',
  reply,
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls: [],
  progress: null,
});

describe('a reply is never failed or rewritten for its language', () => {
  it('sends a Vietnamese reply to an English ask as written, with no retry', async () => {
    const asked = confidentLanguageOf('Continue the ISS-748');
    expect(asked).toBe('en');
    const instructions: string[] = [];
    const reply = 'Mình đã tiếp tục việc này, chia thành ba bước nhỏ để dễ theo dõi nhé.'; // i18n-allow: a production ask or reply replayed as the test case
    const sent = await screenedTurn({
      door: 'web-chat-reply',
      projectId: 'p-1',
      askedIn: asked,
      first: turn(reply),
      retry: async (instruction) => {
        instructions.push(instruction);
        return turn('I continued it and split it into three small steps you can follow.');
      },
      setPhase: () => undefined,
    });
    expect(instructions).toEqual([]);
    expect(sent.said?.text).toBe(reply);
  });

  it('sends an English reply to a Vietnamese ask as written, with no retry', async () => {
    const instructions: string[] = [];
    const reply =
      'The export screen filters by every column the customer uses, and the date column is next.';
    const sent = await screenedTurn({
      door: 'web-chat-reply',
      projectId: 'p-1',
      askedIn: confidentLanguageOf('màn export lọc theo cột nào vậy?'), // i18n-allow: a production ask or reply replayed as the test case
      first: turn(reply),
      retry: async (instruction) => {
        instructions.push(instruction);
        return turn('unused');
      },
      setPhase: () => undefined,
    });
    expect(instructions).toEqual([]);
    expect(sent.said?.text).toBe(reply);
  });
});
