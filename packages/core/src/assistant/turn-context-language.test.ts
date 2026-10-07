// The reply follows the asker's language from its first token: the language the message was written
// in is said beside the message itself, where a long English prompt, English knowledge and English
// tool results cannot outweigh it (dev QA 2026-10-07: a Vietnamese spec ask streamed English for
// ~63 s; a two-word Vietnamese "run ISS-365" was answered in English).

import { describe, expect, it } from 'vitest';
import { askerLanguageOf } from '../conversations/fallback-replies.js';
import { applyTurnContext } from './turn-context.js';

const SPEC_ASK =
  'Soạn giúp mình một spec issue thật dài và chi tiết cho tính năng xuất báo cáo tiến độ hằng tuần của một project ra PDF. Chỉ soạn, đừng tạo issue.'; // i18n-allow: the production ask replayed as the test case

describe('the language a person asked in', () => {
  it('is told from a long message, and from a short one that spells a Vietnamese word', () => {
    expect(askerLanguageOf(SPEC_ASK)).toBe('vi');
    expect(askerLanguageOf('chạy ISS-365')).toBe('vi'); // i18n-allow: the production ask replayed as the test case
    expect(askerLanguageOf('What is the status of ISS-290 right now?')).toBe('en');
  });

  it('is not guessed from a short message that could be either', () => {
    expect(askerLanguageOf('ok')).toBeNull();
    expect(askerLanguageOf('chay ISS-365')).toBeNull();
    expect(askerLanguageOf('ISS-365')).toBeNull();
  });
});

describe('the turn is told to answer in it, beside the message', () => {
  it('the newest message carries the reply language, after the page context', () => {
    const [, asked] = applyTurnContext(
      [
        { role: 'system', content: 'You are forge.' },
        { role: 'user', content: SPEC_ASK },
      ],
      { pageContext: { route: '/projects/forge' }, replyLanguage: 'vi' },
    );
    const content = String(asked?.content);
    expect(content).toContain(
      'Reply language: this message is written in Vietnamese. Write your whole reply in Vietnamese from its first word',
    );
    expect(content.indexOf('Reply language')).toBeGreaterThan(content.indexOf('Page context'));
    expect(content.endsWith(SPEC_ASK)).toBe(true);
  });

  it('a message whose language cannot be told carries no such line', () => {
    const [asked] = applyTurnContext([{ role: 'user', content: 'ok' }], { replyLanguage: null });
    expect(asked?.content).toBe('ok');
  });
});
