import { describe, expect, it, vi } from 'vitest';

const reported: unknown[] = [];
const recorded: unknown[] = [];
const OUTBOX_REFUSAL =
  'Failed query: insert into "pipeline_outbox" ("type") values ($1) — violates check constraint "pipeline_outbox_type_chk"';

vi.mock('../conversations/index.js', () => ({
  codeAuthored: (text: string) => ({ text, authored: 'code' }),
  conversationTransport: () => ({
    deliver: async () => {
      throw new Error(OUTBOX_REFUSAL);
    },
  }),
  errorFallbackReply: () => 'fallback',
  openConversation: async () => ({ id: 'c-1' }),
  recordDeliveredReply: async (row: unknown) => {
    recorded.push(row);
  },
}));
vi.mock('./turn-compose.js', () => ({
  composeReply: async () => ({
    send: true,
    message: { text: 'REQ-1 reads as agreed at revision 1.' },
    screenReplaced: false,
  }),
  silence: () => ({ send: false, reason: 'silence' }),
}));
vi.mock('./screened-reply.js', () => ({ assertAnswerableDoor: () => undefined }));
vi.mock('../credentials/turn-credential.js', () => ({
  CHAT_TURN_MENU: [],
  mintTurnCredential: async () => ({ revoke: async () => undefined }),
}));
vi.mock('../lib/error-tracking.js', () => ({
  reportFailure: (err: unknown) => {
    reported.push(err);
  },
}));

const { runConversationTurn } = await import('./turn-runner.js');

describe('a reply whose delivery fails is kept and reported, not dropped', () => {
  it('the outcome carries the composed reply and the refusal, and the failure reaches error tracking', async () => {
    const outcome = await runConversationTurn({
      door: 'web',
      venue: { adapter: 'web', externalId: 'room-1', shape: 'dm', projectId: 'p-1' },
      authority: { origin: 'message' },
      message: 'agree REQ-1',
    } as never);
    expect(outcome).toEqual({
      kind: 'undeliverable',
      reason: OUTBOX_REFUSAL,
      reply: 'REQ-1 reads as agreed at revision 1.',
    });
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain('pipeline_outbox_type_chk');
    expect(recorded).toEqual([]);
  });
});
