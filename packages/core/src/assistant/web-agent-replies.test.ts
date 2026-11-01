// What Agent mode tells the thread when a turn never reached a box. Its own lines are English only
// (owner ruling ISS-403, 2026-10-08), a last resort no agent wrote, so they are short and name no
// machinery (ISS-857); a box that cannot confine a chat is read as that, never as "session ended" or
// "cannot take this right now" (REQ-30 BC-9, chat-turn step noconfine, ISS-440). The dispatch is the
// one thing replaced.

import { describe, expect, it, vi } from 'vitest';

const dispatched: { replies?: Record<string, unknown> }[] = [];
let outcome: Record<string, unknown> = { started: false, reason: 'no-device' };

vi.mock('../conversations/index.js', async (importOriginal) => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    ...(await importOriginal<object>()),
    codeAuthored: (text: string) => ({ text, proof: null }),
    replyLanguageOf: replies.replyLanguageOf,
    startConversationAgentTurn: async (args: { replies: Record<string, unknown> }) => {
      dispatched.push(args);
      return outcome;
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
      latest: question,
      images: [],
      conversationContext: async () => null,
      reserve: async () => true,
    },
    progress: { onTurnEvent: () => undefined, onSettled: () => undefined, entryId: 'e' } as never,
    externalStop: new AbortController().signal,
  }).divertBeforeTurn?.({ setPhase: () => undefined, authority: { origin: 'message' } } as never);
}

const textOf = (said: Awaited<ReturnType<typeof agentTurn>>) =>
  said && 'message' in said ? said.message.text : '';

const REFUSAL =
  'A chat session holds only its own turn credential, and the runner box mac-mini cannot confine one, so nothing was dispatched: runs macos.';

describe('Agent mode tells the thread why a turn never reached a box', () => {
  it('says Agent mode cannot take it now, with the next step, in English to any asker, and hands the bridge English lines', async () => {
    outcome = { started: false, reason: 'no-device' };
    const said = await agentTurn('đọc code phần export giúp mình, xem lỗi ở đâu'); // i18n-allow: a production ask replayed as the test case
    expect(textOf(said)).toBe(
      'Agent mode cannot take this right now. Try again in a few minutes, or ask in Assistant mode for anything that does not need the code.',
    );
    expect(dispatched.at(-1)?.replies).toEqual({
      dedup: expect.stringContaining('already has an Agent turn running'),
      noDevice: expect.stringContaining('Agent mode cannot take this right now'),
      failed: expect.stringContaining('The agent ended without an answer'),
    });
    for (const line of Object.values(dispatched.at(-1)?.replies ?? {}))
      expect(String(line)).not.toMatch(/runner|paired|device|\bbox\b|session/i);
  });

  it('says a turn is already running, with the next step', async () => {
    outcome = { started: false, reason: 'deduped' };
    const said = await agentTurn('read the export code and tell me where it breaks');
    expect(textOf(said)).toBe(
      'This conversation already has an Agent turn running. Wait for it to answer, or open another conversation to ask something else in parallel.',
    );
  });

  it('reads a box that cannot confine as that, in plain words; the box and its reason stay on the session', async () => {
    outcome = { started: false, reason: 'box-cannot-confine', message: REFUSAL };
    const said = await agentTurn('read the export code and tell me where it breaks');
    expect(textOf(said)).toBe(
      'Agent mode did not run this turn. Ask in Assistant mode for anything that does not need the code.',
    );
    expect(textOf(said)).not.toMatch(/mac-mini|forge-runner|bubblewrap|ended without an answer/);
    expect(said).toMatchObject({ send: true, screenReplaced: false });
  });

  it("leaves a hand-over that threw to that session's bridge, posting nothing itself", async () => {
    outcome = { started: false, reason: 'dispatch-failed' };
    expect(await agentTurn('read the export code')).toEqual({
      send: false,
      reason: 'agent-turn-dispatch-failed',
      ended: 'not-dispatched',
    });
  });
});
