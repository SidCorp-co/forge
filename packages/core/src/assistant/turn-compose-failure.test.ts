import { describe, expect, it, vi } from 'vitest';

const silences: unknown[] = [];

vi.mock('../conversations/index.js', async () => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    codeAuthored: (text: string) => ({ text, authored: 'code' }),
    recordSilence: async (row: unknown) => {
      silences.push(row);
    },
    turnFailureReason: replies.turnFailureReason,
  };
});
vi.mock('../lib/data-egress.js', () => ({ egressDeep: async () => ({ ok: true, value: null }) }));
vi.mock('./external-chat.js', () => ({
  runExternalChatTurn: async () => ({
    conversationId: 'c-1',
    reply: '',
    terminal: 'error',
    error: 'AbortError: This operation was aborted',
    iterations: 3,
    toolCalls: [],
    progress: null,
  }),
}));
vi.mock('./confab.js', () => ({ correctFalseClaims: (text: string) => ({ text }) }));
vi.mock('./screened-reply.js', () => ({
  declinedTail: () => '',
  declinedTurn: () => false,
  screenedTurnReply: async () => null,
}));
vi.mock('./tools/room-send-tool.js', () => ({ roomSendCapture: () => null }));
vi.mock('./tools/mcp-adapter.js', () => ({ mergeToolsets: () => undefined }));
vi.mock('../credentials/turn-credential.js', () => ({ turnAuthorityRefusalOf: () => null }));

const { composeReply } = await import('./turn-compose.js');
const { TURN_TIMED_OUT } = await import('./conversation-stops.js');

function ctxWith(abortReason: unknown) {
  const abort = new AbortController();
  abort.abort(abortReason);
  return {
    req: {
      venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
      authority: { userId: 'u-1', origin: 'message' },
      handleName: 'catalog-api',
      message: 'please draw the designs',
      mayDecline: true,
      sendMode: 'reply',
      questionAlreadyRecorded: true,
    },
    conversationId: 'c-1',
    abort,
    setPhase: () => undefined,
    credential: async () => {
      throw new Error('no token in this test');
    },
  } as never;
}

describe('a turn that ends in an error is a coded failure, never a declined silence', () => {
  it('the 90-second ceiling reads as ASSISTANT_TURN_TIMED_OUT and records no silence row', async () => {
    silences.length = 0;
    const reply = await composeReply(ctxWith(TURN_TIMED_OUT));
    expect(reply).toMatchObject({ send: false, ended: 'failed', code: 'ASSISTANT_TURN_TIMED_OUT' });
    expect(JSON.stringify(reply)).not.toContain('AbortError');
    expect(silences).toEqual([]);
  });

  it('any other error reads as ASSISTANT_TURN_FAILED', async () => {
    const reply = await composeReply(ctxWith(new Error('upstream reset')));
    expect(reply).toMatchObject({ send: false, ended: 'failed', code: 'ASSISTANT_TURN_FAILED' });
  });
});
