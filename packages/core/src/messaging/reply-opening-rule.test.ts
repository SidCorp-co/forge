// REQ-41 BC-30: a reply opens with its answer, never with agreement to something the person did not
// say. The pairs are the owner's messages and the replies they got on dev (conversation a760cd5f,
// 2026-10-21/22), screened at the Assistant's door.

import { describe, expect, it, vi } from 'vitest';
import { facts } from './facts.js';

vi.mock('./gather.js', () => ({
  gatherFacts: async (input: { question?: string }) =>
    facts({ prefix: 'ISS', prefixes: ['ISS'], question: input.question ?? null }),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');
const { saidKind, withoutFalseOpening } = await import('./reply-opening-rule.js');

const held = async (question: string | undefined, reply: string) => {
  const v = await screenReplyAtDoor('web-chat-reply', {
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    conversationId: 'c-1',
    segments: [reply],
    toolCalls: [],
    progress: null,
    ...(question === undefined ? {} : { question }),
  });
  return v.ok ? [] : v.refusals.filter((r) => r.rule === 'opens-with-its-answer');
};

describe('a reply that opens by agreeing with what nobody said is held (REQ-41 BC-30)', () => {
  it('holds "correct." in Vietnamese opening the answer to a question', async () => {
    const r = await held(
      'TÌnh trạng cái nào đang xử lý cái nào đang treo bạn check được không', // i18n-allow: the owner's message on dev
      'Đúng. Hiện không có issue nào đang chạy.', // i18n-allow: the reply the owner got
    );
    expect(r.map((x) => x.quote)).toEqual(['Đúng']); // i18n-allow: the opening quoted
    expect(r[0]?.why).toContain('asks a question');
  });

  it('holds "yes." in Vietnamese opening the answer to a request', async () => {
    const r = await held(
      'Cái nào bạn thấy đơn giản và quyết định được thì giúp tôi đi', // i18n-allow: the owner's message on dev
      'Có. Theo Needs you, REQ-25 nên được chấp nhận.', // i18n-allow: the reply the owner got
    );
    expect(r.map((x) => x.quote)).toEqual(['Có']); // i18n-allow: the opening quoted
    expect(r[0]?.why).toContain('asks for something to be done');
  });

  it('holds "correct —" in Vietnamese opening the answer to an instruction', async () => {
    const r = await held(
      'feedback cho forge dev xử lý để hạn chế tạo ra các issue verify này', // i18n-allow: the owner's message on dev
      'Đúng — chưa có requirement nào được ghi.', // i18n-allow: the reply the owner got
    );
    expect(r).toHaveLength(1);
  });

  it('holds "Correct," and "Yes." in English the same way', async () => {
    expect(await held('Is ISS-5 done?', 'Correct, ISS-5 is open.')).toHaveLength(1);
    expect(await held('Open ISS-5 for me please', 'Yes. ISS-5 is open now.')).toHaveLength(1);
  });

  it('passes agreement with a statement the person made', async () => {
    expect(
      await held(
        'Muốn xử lý issue mà loằng ngoằng quá nhỉ, đây là vấn đề về UX của forge đang khá tệ', // i18n-allow: the owner's statement on dev
        'Đúng — đây là vấn đề UX, không chỉ là thao tác nhiều bước.', // i18n-allow: the reply the owner got
      ),
    ).toEqual([]);
    expect(await held('Lỗi tiếp', 'Đúng, lỗi vẫn lặp lại.')).toEqual([]); // i18n-allow: the owner's statement on dev
  });

  it('passes "yes" answering a yes-or-no question, and a word that only starts like one', async () => {
    expect(await held('bạn check được không?', 'Có. ISS-5 đang mở.')).toEqual([]); // i18n-allow: a yes-or-no question
    expect(await held('What is open?', 'Right now ISS-5 is open.')).toEqual([]);
    expect(await held('Khi nào xong?', 'Đúng hạn hôm nay, ISS-5 xong.')).toEqual([]); // i18n-allow: "on time" is not agreement
  });

  it('judges nothing where the screen has no question', async () => {
    expect(await held(undefined, 'Correct, ISS-5 is open.')).toEqual([]);
  });
});

describe('what the person said, as the opening rule reads it', () => {
  it('tells a question, a request and a statement apart', () => {
    expect(saidKind('Tôi thấy có 29 yêu cầu đang chờ tôi approved à')).toBe('question'); // i18n-allow: the owner's question on dev
    expect(saidKind('Khi nào mới được xử lý?')).toBe('question'); // i18n-allow: the owner's question on dev
    expect(saidKind('Ok mở cho tôi cụm đó đi')).toBe('request'); // i18n-allow: the owner's request on dev
    expect(saidKind('Check tình trạng hiện tại')).toBe('request'); // i18n-allow: the owner's request on dev
    expect(saidKind('Vẫn lỗi')).toBe('statement'); // i18n-allow: the owner's statement on dev
  });

  it('takes a false opening off, raising what follows', () => {
    const agreed = 'Đúng — chưa có requirement nào.'; // i18n-allow: the reply on dev
    const yes = 'Có. Theo Needs you, REQ-25 chờ.'; // i18n-allow: the reply on dev
    expect(withoutFalseOpening(agreed, agreed.slice(0, 4))).toBe(
      agreed.slice(7, 8).toUpperCase() + agreed.slice(8),
    );
    expect(withoutFalseOpening(yes, yes.slice(0, 2))).toBe(yes.slice(4));
  });
});
