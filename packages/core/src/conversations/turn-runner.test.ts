/**
 * ISS-1002 — what a turn does, for a transport that supplies the four ports.
 *
 * The subject is the half ISS-1001 left inside one adapter: which text reaches
 * the venue, which text reaches the transcript, and how each way a turn can end
 * tells itself apart.
 *
 * A turn here starts from a venue and a principal already settled;
 * `inbound-turn.test.ts` is the half in front of it, and holds the claim that a
 * transport's own frame reaches this over four port functions and nothing else.
 * A case that has to add a callback to get a turn to complete is the copy of the
 * turn path coming back, one hook at a time.
 *
 * `connection-manager-delivery.test.ts` was this file's ancestor. Two of its
 * cases did not come across: both asserted a delivery receipt stamped onto a row
 * the model wrote, and a screened turn never writes one.
 */

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
const { unverifiedFallbackReply, errorFallbackReply, emptyFallbackReply } = await import(
  './fallback-replies.js'
);

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
  screenReplyAtDoor.mockResolvedValue({ ok: true });
  runExternalChatTurn.mockResolvedValue(answered);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a turn for a transport that is four functions', () => {
  // cm:guard no adapter callback at all: a case that has to pass a hook to get a turn to complete is the copy of the turn path coming back, one callback at a time (ISS-1002 outcome).
  it('runs, screens, delivers and records with no adapter callback at all', async () => {
    const outcome = await runConversationTurn(request());

    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ text: 'an answer' }), {
      addressee: null,
    });
    expect(recordDeliveredReply).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      text: 'an answer',
      receipt: { messageId: 'server-id-9' },
    });
    expect(outcome).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
  });

  // cm:guard the runner reaches the venue through the REGISTERED transport and holds no door of its own: a runner that could be handed a door would let each adapter bring one, which is the second outbound path `outbound.test.ts` exists to refuse on the transport's own side.
  it('refuses by name when the venue names an adapter no transport registered', async () => {
    clearConversationTransports();
    await expect(runConversationTurn(request())).rejects.toThrow(
      /no transport is registered for adapter "widget"/,
    );
  });

  // cm:guard a door whose ending is `refusal` owes nobody a reply, so substituting a fallback for one would post words its writer never wrote — the refusal has to be louder than the near-miss (ISS-997).
  it('refuses by name when asked to answer at a door that ends in a refusal', async () => {
    await expect(runConversationTurn(request({ door: 'comment-write' }))).rejects.toThrow(
      /"comment-write" ends in a refusal/,
    );
  });

  it('writes the question and never the answer, so the screen reads text no row holds yet', async () => {
    await runConversationTurn(request());
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      record: 'question-only',
      conversationId: 'conv-1',
      userId: 'user-1',
      userKey: 'speaker-1',
    });
  });
});

describe('who the turn speaks as, and to', () => {
  // cm:guard three values, three meanings, and the runner keeps them apart: an absent speaker is the principal speaking, an explicit null is an unlinked author and stays null, and the handle rides the request rather than a store read (ISS-1034 criteria 18-20, 62-64).
  it('hands the linked speaker and their label to the turn, and the handle to the hooks, beside the principal', async () => {
    let seen: Record<string, unknown> | null = null;
    await runConversationTurn(
      request({
        speakerUserId: 'speaker-user',
        handleUserId: 'handle-1',
        prepare: async (hook: Record<string, unknown>) => {
          seen = hook;
          return {};
        },
      }),
    );
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      speakerUserId: 'speaker-user',
      speakerLabel: 'speaker-1',
    });
    expect(seen).toMatchObject({
      principalUserId: 'user-1',
      speakerUserId: 'speaker-user',
      handleUserId: 'handle-1',
      conversationId: 'conv-1',
    });
  });

  it('keeps an explicit null speaker null instead of falling back to the principal', async () => {
    await runConversationTurn(request({ speakerUserId: null }));
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      speakerUserId: null,
    });
  });

  it('reads an absent speaker as the principal speaking', async () => {
    await runConversationTurn(request());
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({ speakerUserId: 'user-1' });
  });
});

describe('which text reaches the venue', () => {
  it('hands the model’s own text to deliver when the screen passes first time', async () => {
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: '  spaced answer  ' });
    await runConversationTurn(request());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'spaced answer' });
  });

  // cm:guard the rejected text never reaches the venue and never reaches the transcript: the room saw the RETRY, and a transcript holding what the screen refused is a record of a conversation nobody had.
  it('hands the retry’s text to deliver, and the rejected attempt to nothing', async () => {
    screenReplyAtDoor
      .mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] })
      .mockResolvedValueOnce({ ok: true });
    runExternalChatTurn
      .mockResolvedValueOnce({ ...answered, reply: 'rejected text' })
      .mockResolvedValueOnce({ ...answered, reply: 'the retry answer' });

    await runConversationTurn(request());

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'the retry answer' });
    expect(recordDeliveredReply.mock.calls[0]?.[0]).toMatchObject({ text: 'the retry answer' });
    expect(runExternalChatTurn.mock.calls[1]?.[0]).toMatchObject({ record: 'nothing' });
  });

  it('hands the code-authored unverified fallback to deliver once the budget is spent', async () => {
    screenReplyAtDoor.mockResolvedValue({ ok: false, refusals: [REFUSAL] });
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: 'still bad' });

    await runConversationTurn(request());

    const sent = deliver.mock.calls[0]?.[1] as { text: string };
    expect(sent.text).toBe(unverifiedFallbackReply('Babo'));
    expect(deliver.mock.calls.map((c) => (c[1] as { text: string }).text)).not.toContain(
      'still bad',
    );
  });

  it('names an empty answer as empty rather than as an error', async () => {
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: '   ' });
    await runConversationTurn(request());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: emptyFallbackReply('Babo') });
  });

  it('names an empty answer whose turn errored as an error', async () => {
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: '', terminal: 'error' });
    await runConversationTurn(request());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: errorFallbackReply('Babo') });
  });

  // cm:guard the fallback goes out when the turn stalls, because the message was SEEN: the abort cancels the provider and this backstops a hang the abort cannot reach, and without one the speaker is left in a silence nothing reports.
  it('delivers the error fallback when the turn outlives the handle timeout', async () => {
    vi.useFakeTimers();
    runExternalChatTurn.mockImplementation(() => new Promise(() => {}));

    const running = runConversationTurn(request());
    await vi.advanceTimersByTimeAsync(130_000);
    const outcome = await running;

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: errorFallbackReply('Babo') });
    expect(outcome).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: true }),
      'conversations: turn failed',
    );
  });
});

describe('a venue that can no longer be reached', () => {
  // cm:guard nothing is recorded when the door refuses: the venue never saw this text, and a row for it would say the opposite. The commonest refusal is a room rebound while the turn ran, which the port names rather than swallows.
  it('records nothing and says it could not deliver', async () => {
    deliver.mockRejectedValue(new Error('no active connection holds a binding for room room-1'));

    const outcome = await runConversationTurn(request());

    expect(recordDeliveredReply).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'undeliverable' });
    expect((outcome as { reason: string }).reason).toMatch(/binding for room room-1/);
  });
});

describe('a turn the adapter hands to another path', () => {
  // cm:guard diverted is NOT a failure and the answer arrives by the path the adapter handed it to: posting here as well is the double reply ISS-727 names (ISS-1002 invariant 4's fourth state).
  it('delivers nothing and records nothing when the diversion posts nothing', async () => {
    const outcome = await runConversationTurn(
      request({ divertBeforeTurn: async () => ({ send: false, reason: 'handed-off' }) }),
    );

    expect(deliver).not.toHaveBeenCalled();
    expect(recordDeliveredReply).not.toHaveBeenCalled();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'diverted', reason: 'handed-off' });
  });

  // cm:guard the diversion runs BEFORE the inputs are built: an adapter that hands the whole turn elsewhere needs none of them, and building a toolset for a turn nobody takes is work paid for nothing.
  it('builds no turn inputs at all when it diverts before the model runs', async () => {
    const prepare = vi.fn(async () => ({}));
    await runConversationTurn(
      request({ prepare, divertBeforeTurn: async () => ({ send: false, reason: 'handed-off' }) }),
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it('delivers the code-authored text a diversion hands back, unscreened', async () => {
    const { codeAuthored } = await import('./ports.js');
    await runConversationTurn(
      request({
        divertBeforeTurn: async () => ({ send: true, message: codeAuthored('no runner is free') }),
      }),
    );
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'no runner is free' });
    expect(screenReplyAtDoor).not.toHaveBeenCalled();
  });

  it('takes a diversion decided on what the model called, after the turn', async () => {
    await runConversationTurn(
      request({ divertAfterTurn: async () => ({ send: false, reason: 'escalated' }) }),
    );
    expect(runExternalChatTurn).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(screenReplyAtDoor).not.toHaveBeenCalled();
  });

  it('releases what the adapter prepared however the turn ended', async () => {
    const dispose = vi.fn(async () => {});
    deliver.mockRejectedValue(new Error('gone'));
    await runConversationTurn(request({ dispose }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('what a watcher of the turn is told (ISS-1078)', () => {
  it('names the delivered text, once, on the ordinary path', async () => {
    const onSettled = vi.fn();

    await runConversationTurn(request({ onSettled }));

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ text: 'an answer', screenReplaced: false });
  });

  // cm:guard `screenReplaced` is what the watcher draws its correction marker from, and the whole
  // reason it is a FACT carried from here rather than a comparison made there: a turn that calls a
  // tool answers in two model round trips, so the prose a watcher accumulated holds the preamble as
  // well and differs from the one reply that goes out — every single time. A watcher inferring a
  // refusal from that difference told the reader of every tool-using turn that their draft had failed
  // the reply check. Measured on a local walk against the real stack, 2026-09-17.
  it('says the screen replaced NOTHING when it admitted what the turn produced', async () => {
    const onSettled = vi.fn();
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: 'an answer' });

    await runConversationTurn(request({ onSettled }));

    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ screenReplaced: false }));
  });

  it('says the screen replaced the draft when the retry is what went out', async () => {
    const onSettled = vi.fn();
    screenReplyAtDoor
      .mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] })
      .mockResolvedValueOnce({ ok: true });
    runExternalChatTurn
      .mockResolvedValueOnce({ ...answered, reply: 'rejected text' })
      .mockResolvedValueOnce({ ...answered, reply: 'the retry answer' });

    await runConversationTurn(request({ onSettled }));

    expect(onSettled).toHaveBeenCalledWith({
      text: 'the retry answer',
      screenReplaced: true,
    });
  });

  // cm:guard the repair budget running out is a replacement too, and a louder one: what goes out is
  // code-authored and no attempt of the model's survived it.
  it('says the screen replaced the draft when the budget ran out', async () => {
    const onSettled = vi.fn();
    screenReplyAtDoor.mockResolvedValue({ ok: false, refusals: [REFUSAL] });
    runExternalChatTurn.mockResolvedValue({ ...answered, reply: 'still bad' });

    await runConversationTurn(request({ onSettled }));

    expect(onSettled).toHaveBeenCalledWith({
      text: unverifiedFallbackReply('Babo'),
      screenReplaced: true,
    });
  });

  // cm:guard THE consult F2 case: the screen is not the only thing that replaces a draft. A turn that
  // throws or times out gets a code-authored fallback built in `runConversationTurn`'s catch, which
  // never reaches the end of `composeReply` — so a watcher told only about screen refusals would let a
  // streamed draft be silently replaced by the error sentence.
  it('names the fallback when the turn threw, so a streamed draft is not silently replaced', async () => {
    const onSettled = vi.fn();
    runExternalChatTurn.mockRejectedValue(new Error('the provider went away'));

    await runConversationTurn(request({ onSettled }));

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      text: errorFallbackReply('Babo'),
      // cm:guard TRUE, and this is the one path where the screen never ran at all: the fallback still
      // replaces whatever streamed before the throw, and a reader watching prose arrive is owed the
      // fact that what they saw is not what went out.
      screenReplaced: true,
    });
    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ problems: [] }), {
      addressee: null,
    });
  });

  // cm:guard after the delivery guard and never before it: a turn whose right to answer moved to
  // another holder sends nothing, and announcing a correction for text it never sent would be a
  // correction to a room that saw neither version.
  it('tells a watcher nothing when the turn was superseded', async () => {
    const onSettled = vi.fn();

    const outcome = await runConversationTurn(
      request({ onSettled, onBeforeDeliver: async () => false }),
    );

    expect(outcome).toMatchObject({ kind: 'superseded' });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('writes the identity and the blocks the watcher resolved for the delivered text', async () => {
    const replyEntry = vi.fn((text: string) => ({
      id: 'entry-1',
      blocks: [{ type: 'text' as const, text }],
    }));

    await runConversationTurn(request({ replyEntry }));

    expect(replyEntry).toHaveBeenCalledWith('an answer');
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'entry-1',
        blocks: [{ type: 'text', text: 'an answer' }],
      }),
    );
  });

  it('records no identity and no blocks when nothing is watching', async () => {
    await runConversationTurn(request());

    const recorded = recordDeliveredReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(recorded).not.toHaveProperty('messageId');
    expect(recorded).not.toHaveProperty('blocks');
  });
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

  it('records the text the transport says it delivered, where it changed it', async () => {
    deliver.mockResolvedValue({ messageId: 'server-id-9', deliveredText: '@alice an answer' });
    await runConversationTurn(request({ addressee: 'alice' }));
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: '@alice an answer' }),
    );
  });
});
