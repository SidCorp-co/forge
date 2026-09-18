/**
 * ISS-1088 — what the turn runner does for the window path's two new inputs:
 * `fallbacks: 'silence'`, which ends a failed turn as a named silence instead
 * of an apology, and `addressee`, which the transport is handed and the screen
 * never sees; and the rule that once the door has taken the text nothing after
 * it may turn the answer into a failure.
 *
 * The mock header is `turn-runner.test.ts`'s, which was at its line ceiling.
 */

// cm:guard a mock screen ADMITS the segments it was shown, rather than returning a bare `ok`:
// since ISS-978 a verdict carries what it was passed over, and a fake one that records nothing
// mints no proof — so a mock that merely says "it passed" silently turns every delivery in this
// file into a fallback.
import { admitted } from '../messaging/screen.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../observability/sentry.js', () => ({ Sentry: { captureException: vi.fn() } }));

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

const runExternalChatTurn = vi.fn();
vi.mock('../assistant/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

const openConversation = vi.fn(async (..._a: unknown[]) => ({
  id: 'conv-1',
  adapter: 'widget',
  externalId: 'venue-1',
  shape: 'group',
  title: null,
}));
vi.mock('./store.js', () => ({
  openConversation: (...a: unknown[]) => openConversation(...(a as [never])),
}));

const recordDeliveredReply = vi.fn(async (..._a: unknown[]) => undefined);
const recordSilence = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [never])),
  recordSilence: (...a: unknown[]) => recordSilence(...(a as [never])),
}));

const screenReplyAtDoor = vi.fn();
vi.mock('../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: (...a: unknown[]) => screenReplyAtDoor(...a),
}));

const { runConversationTurn } = await import('./turn-runner.js');
const { clearConversationTransports, registerConversationTransport } = await import('./ports.js');
const { unverifiedFallbackReply } = await import('./fallback-replies.js');

/** The neutral half of a transport: what the registry holds, and all a turn can reach. */
const deliver = vi.fn(
  async (..._a: unknown[]): Promise<{ messageId: string; deliveredText?: string }> => ({
    messageId: 'server-id-9',
  }),
);
const fetchHistory = vi.fn(async (..._a: unknown[]) => []);

const VENUE = {
  adapter: 'widget' as const,
  externalId: 'venue-1',
  shape: 'group' as const,
  projectId: 'proj-1',
};

const REFUSAL = {
  rule: 'no-developer-detail',
  why: 'leaks a code fence',
  quote: null,
  shape: 'plain language',
  example: 'The fix is in.',
} as const;

const answered = {
  conversationId: 'conv-1',
  assistantMessageId: null,
  reply: 'an answer',
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls: [],
  progress: null,
};

/** The whole request: a venue, who it runs as, the message, the door. No hooks. */
const request = (over: Record<string, unknown> = {}) => ({
  venue: VENUE,
  principalUserId: 'user-1',
  speakerKey: 'speaker-1',
  message: 'How does the pipeline work?',
  door: 'chat-sync' as const,
  handleName: 'Babo',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearConversationTransports();
  registerConversationTransport({ adapter: 'widget', deliver, fetchHistory });
  deliver.mockResolvedValue({ messageId: 'server-id-9' });
  screenReplyAtDoor.mockImplementation(async (_door: unknown, input: { segments: readonly string[] }) =>
    admitted(input.segments),
  );
  runExternalChatTurn.mockResolvedValue(answered);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fallbacks silenced, and the addressee (ISS-1088 criteria 19, 21, 22)', () => {
  it('posts no apology when the screen is exhausted under fallbacks: silence — a named silence instead', async () => {
    screenReplyAtDoor.mockResolvedValue({ ok: false, refusals: [REFUSAL] });
    const out = await runConversationTurn(request({ fallbacks: 'silence', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'screen-refused' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'screen-refused' }),
    );
  });

  it('posts no apology when the turn throws under fallbacks: silence, and records turn-failed', async () => {
    runExternalChatTurn.mockRejectedValue(new Error('provider exploded'));
    const out = await runConversationTurn(request({ fallbacks: 'silence', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'turn-failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(expect.objectContaining({ reason: 'turn-failed' }));
  });

  it('still posts the apology under fallbacks: post, as before', async () => {
    screenReplyAtDoor.mockResolvedValue({ ok: false, refusals: [REFUSAL] });
    await runConversationTurn(request({ fallbacks: 'post' }));
    expect(deliver).toHaveBeenCalledWith(
      VENUE,
      expect.objectContaining({ text: unverifiedFallbackReply('Babo') }),
      { addressee: null },
    );
  });

  it('hands the addressee to deliver and never writes it into the screened text', async () => {
    await runConversationTurn(request({ addressee: 'alice' }));
    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ text: 'an answer' }), {
      addressee: 'alice',
    });
    expect(screenReplyAtDoor.mock.calls[0]?.[1]).toMatchObject({ segments: ['an answer'] });
  });

  it('stays delivered when the transcript write rejects after the door took the text (pass A F1)', async () => {
    recordDeliveredReply.mockRejectedValueOnce(new Error('transcript down'));
    const out = await runConversationTurn(request());
    expect(out).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'transcript down' }) }),
      expect.stringContaining('the outcome stays delivered'),
    );
  });

  it('stays delivered when the caller’s replyEntry hook throws after delivery', async () => {
    const out = await runConversationTurn(
      request({
        replyEntry: () => {
          throw new Error('hook exploded');
        },
      }),
    );
    expect(out).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
    expect(recordDeliveredReply).not.toHaveBeenCalled();
  });

  it('records the text the transport says it delivered, where it changed it', async () => {
    deliver.mockResolvedValue({ messageId: 'server-id-9', deliveredText: '@alice an answer' });
    await runConversationTurn(request({ addressee: 'alice' }));
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: '@alice an answer' }),
    );
  });
});
