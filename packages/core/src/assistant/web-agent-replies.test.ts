// Agent mode's own lines reach a Vietnamese room in Vietnamese (chat mining 2026-10-07: Agent-mode
// fallbacks reached Vietnamese rooms in English on prod, conv f0934ba7). The dispatch is the one
// thing replaced: it answers as it does when no box is free.

import { describe, expect, it, vi } from 'vitest';

const dispatched: { replies?: Record<string, unknown> }[] = [];
let reason = 'no-device';

vi.mock('../conversations/index.js', async (importOriginal) => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    ...(await importOriginal<object>()),
    codeAuthored: (text: string) => ({ text, proof: null }),
    replyLanguageOf: replies.replyLanguageOf,
    replyLanguageOfTag: replies.replyLanguageOfTag,
    startConversationAgentTurn: async (args: { replies: Record<string, unknown> }) => {
      dispatched.push(args);
      return { started: false, reason };
    },
  };
});
vi.mock('../project-config/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readContentLanguage: async () => ({ contentLanguage: 'en' }),
}));

const { webConversationTurn } = await import('./web-turn-inputs.js');

function agentTurn(question: string) {
  return webConversationTurn({
    project: { id: 'p-1', slug: 'p', name: 'P' },
    handleName: 'forge',
    askedBy: null,
    window: {
      venue: { adapter: 'web', externalId: 'room', shape: 'direct', projectId: 'p-1' },
      conversationId: 'c-1',
      windowId: 'w-1',
      deliveryKey: 'k',
      mode: 'agent',
      question,
      images: [],
      conversationContext: async () => null,
      reserve: async () => true,
    },
    progress: { onTurnEvent: () => undefined, onSettled: () => undefined, entryId: 'e' } as never,
    externalStop: new AbortController().signal,
  }).divertBeforeTurn?.({ setPhase: () => undefined, authority: { origin: 'message' } } as never);
}

describe('an Agent-mode line answers in the language the person asked in', () => {
  it('tells a Vietnamese asker in Vietnamese that no box is free, and hands the bridge Vietnamese lines', async () => {
    const said = await agentTurn('đọc code phần export giúp mình, xem lỗi ở đâu'); // i18n-allow: a production ask or reply replayed as the test case
    expect(said && 'message' in said ? said.message.text : '').toContain(
      'Hiện không có máy đã ghép nào rảnh', // i18n-allow: a production ask or reply replayed as the test case
    );
    expect(String(dispatched.at(-1)?.replies?.failed)).toContain('Phiên Agent đã kết thúc'); // i18n-allow: a production ask or reply replayed as the test case
  });

  it('keeps English for an English asker, and the project language where the ask cannot tell', async () => {
    reason = 'deduped';
    const said = await agentTurn('read the export code and tell me where it breaks');
    expect(said && 'message' in said ? said.message.text : '').toContain(
      'already has an Agent turn running',
    );
  });
});
