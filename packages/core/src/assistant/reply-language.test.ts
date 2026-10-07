// Replies in a language the person did not write in (chat mining 2026-10-07: 12 English questions
// answered in Vietnamese, 4 people). The asks are the production ones, anonymised.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../messaging/gather.js', async () => {
  const { NO_FACTS } = await import('../messaging/facts.js');
  return { gatherFacts: async () => NO_FACTS };
});

import { confidentLanguageOf } from '../conversations/fallback-replies.js';
import { admitted } from '../messaging/screen.js';
import { withReplyLanguage } from './screened-reply.js';

describe('the reply is held to the language the person wrote in', () => {
  it('refuses a Vietnamese reply to an English ask', () => {
    const asked = confidentLanguageOf('Continue the ISS-748');
    expect(asked).toBe('en');
    const verdict = withReplyLanguage(
      admitted(['x']),
      'Đã tiếp tục ISS-748 bằng implementation breakdown, chia thành ba bước nhỏ để dễ theo dõi.', // i18n-allow: a production ask or reply replayed as the test case
      asked,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusals[0]?.why).toBe(
      'the person wrote in English and the reply is in Vietnamese',
    );
  });

  it('refuses an English reply to a Vietnamese ask', () => {
    const verdict = withReplyLanguage(
      admitted(['x']),
      'The export screen filters by every column the customer uses, and the date column is next.',
      confidentLanguageOf('màn export lọc theo cột nào vậy?'), // i18n-allow: a production ask or reply replayed as the test case
    );
    expect(!verdict.ok && verdict.refusals[0]?.rule).toBe('reply-language');
  });

  it('passes a matching reply, and judges nothing it cannot tell', () => {
    const ok = admitted(['x']);
    expect(withReplyLanguage(ok, 'ISS-61 đang chờ phát hành, chưa có gì chặn.', 'vi')).toBe(ok); // i18n-allow: a production ask or reply replayed as the test case
    expect(withReplyLanguage(ok, 'ISS-61 · ISS-62', 'vi')).toBe(ok);
    expect(confidentLanguageOf('cho chay issue ngay')).toBe(null);
    expect(confidentLanguageOf('ok ISS-12')).toBe(null);
    expect(withReplyLanguage(ok, 'The export is done and the date filter works.', null)).toBe(ok);
  });

  it('reads Vietnamese typed without its marks where its function words carry it', () => {
    expect(confidentLanguageOf('xem giup minh cai nay nha')).toBe('vi');
  });
});

describe('the screen asks for the reply again in the person’s language', () => {
  it('retries a Vietnamese reply to an English ask, and sends the English rewrite', async () => {
    const { screenedTurnReply } = await import('./screened-reply.js');
    const asked: string[] = [];
    const turn = (reply: string) => ({
      conversationId: 'c-1',
      reply,
      terminal: 'done' as const,
      error: null,
      iterations: 1,
      toolCalls: [],
      progress: null,
    });
    const sent = await screenedTurnReply({
      door: 'web-chat-reply',
      projectId: 'p-1',
      handleName: 'forge',
      language: 'en',
      askedIn: confidentLanguageOf('Continue the ISS-748'),
      first: turn('Mình đã tiếp tục việc này, chia thành ba bước nhỏ để dễ theo dõi nhé.'), // i18n-allow: a production ask or reply replayed as the test case
      retry: async (instruction) => {
        asked.push(instruction);
        return turn('I continued it and split it into three small steps you can follow.');
      },
      setPhase: () => undefined,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('the person wrote in English and the reply is in Vietnamese');
    expect(sent?.text).toBe('I continued it and split it into three small steps you can follow.');
  });
});
