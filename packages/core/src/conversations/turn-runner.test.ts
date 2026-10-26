// A turn a person stopped, and the three places the stop can arrive.
//
// The runner links an outside signal to its own abort and is the one place
// that decides what a stopped turn becomes. Each case below is a moment the
// stop can land in: before the turn is composed, while it is composing (which
// throws), and on a composition that ENDS rather than raising, which is what a
// provider answering a cancelled call with an error result does.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const openConversation = vi.fn(async () => ({ id: 'conv-1' }));
vi.mock('./store.js', () => ({ openConversation: () => openConversation() }));

const deliver = vi.fn(async () => ({ messageId: 'm1' }));
vi.mock('./ports.js', async (orig) => ({
  ...(await orig<typeof import('./ports.js')>()),
  conversationTransport: () => ({ adapter: 'web', deliver }),
}));

const runExternalChatTurn = vi.fn();
vi.mock('../assistant/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const recordSilence = vi.fn();
vi.mock('./transcript.js', () => ({
  recordSilence: (...args: unknown[]) => recordSilence(...args),
  recordDeliveredReply: vi.fn(async () => ({ messageId: 'm1' })),
}));

// The reply check reads the tracker; a written reply passes it untouched here unless a test refuses it,
// and an empty one goes to the real check.
const refused = new Set<string>();
vi.mock('./screened-reply.js', async (orig) => {
  const real = await orig<typeof import('./screened-reply.js')>();
  return {
    ...real,
    screenedTurnReply: (args: Parameters<typeof real.screenedTurnReply>[0]) =>
      refused.has(args.first.reply)
        ? Promise.resolve(null)
        : args.first.reply.trim()
          ? Promise.resolve({ text: args.first.reply, problems: [] })
          : real.screenedTurnReply(args),
  };
});

const { runConversationTurn } = await import('./turn-runner.js');

const VENUE = {
  adapter: 'web' as const,
  externalId: 'web room-1',
  shape: 'direct' as const,
  projectId: 'proj-1',
};

function request(over: Record<string, unknown> = {}) {
  return {
    door: 'web-chat-reply' as const,
    venue: VENUE,
    message: 'what is in this picture',
    principalUserId: 'user-1',
    handleName: 'Forge',
    fallbacks: 'silence' as const,
    ...over,
  };
}

describe('a turn a person stopped', () => {
  beforeEach(() => {
    runExternalChatTurn.mockReset();
    deliver.mockReset();
    recordSilence.mockReset();
  });

  it('composes nothing at all where the stop arrived before the turn began', async () => {
    const stop = new AbortController();
    stop.abort('stopped-by-a-person');

    const outcome = await runConversationTurn(request({ externalStop: stop.signal }) as never);

    expect(outcome).toEqual({ kind: 'stopped', reason: 'stopped-by-a-person' });
    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).not.toHaveBeenCalled();
  });

  it('delivers nothing where the composition ENDED on the stop rather than throwing', async () => {
    const stop = new AbortController();
    runExternalChatTurn.mockImplementation(async () => {
      stop.abort('stopped-by-a-person');
      return { terminal: 'aborted', reply: '', error: 'aborted', toolCalls: [], iterations: 1 };
    });

    const outcome = await runConversationTurn(request({ externalStop: stop.signal }) as never);

    expect(outcome).toEqual({ kind: 'stopped', reason: 'stopped-by-a-person' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).not.toHaveBeenCalled();
  });

  it('says stopped rather than failed where the composition threw on the stop', async () => {
    const stop = new AbortController();
    runExternalChatTurn.mockImplementation(async () => {
      stop.abort('stopped-by-a-person');
      throw new Error('aborted');
    });

    const outcome = await runConversationTurn(request({ externalStop: stop.signal }) as never);

    expect(outcome).toEqual({ kind: 'stopped', reason: 'stopped-by-a-person' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).not.toHaveBeenCalled();
  });

  it('disposes once, and not once per exit', async () => {
    const stop = new AbortController();
    const dispose = vi.fn(async () => {});
    runExternalChatTurn.mockImplementation(async () => {
      stop.abort('stopped-by-a-person');
      throw new Error('aborted');
    });

    await runConversationTurn(request({ externalStop: stop.signal, dispose }) as never);

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// ISS-1229 r40, judge-111: a silence the reply check caused reads, in the room, that the reply was
// withheld. An empty reply the check never refused is recorded as what it is.
describe('a reply that posts nothing', () => {
  beforeEach(() => {
    runExternalChatTurn.mockReset();
    deliver.mockReset();
    recordSilence.mockReset();
  });

  it('records an empty reply as empty, not as one the reply check refused', async () => {
    runExternalChatTurn.mockResolvedValue({
      terminal: 'done',
      reply: '  ',
      toolCalls: [],
      iterations: 1,
    });

    const outcome = await runConversationTurn(request() as never);

    expect(outcome).toEqual({ kind: 'declined', reason: 'empty-reply' });
    expect(recordSilence).toHaveBeenCalledWith(expect.objectContaining({ reason: 'empty-reply' }));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('names the stored silence by its seq, so the window it closes can say which', async () => {
    runExternalChatTurn.mockResolvedValue({
      terminal: 'done',
      reply: '',
      toolCalls: [],
      iterations: 1,
    });
    recordSilence.mockResolvedValue(7);

    const outcome = await runConversationTurn(request() as never);

    expect(outcome).toEqual({ kind: 'declined', reason: 'empty-reply', silenceSeq: 7 });
  });

  // ISS-1229 r44: a reply withheld for a credential said only that it held something the tracker does not show.
  it.each([
    ['https://ci.test/run?token=Zq8VtR2mK9xLp4Wd is the build link.', 'screen-refused-credential'],
    ['ISS-4242 shipped in v9.2.', 'screen-refused'],
  ])('records a refused reply by why it was refused: %s', async (reply, reason) => {
    refused.add(reply);
    runExternalChatTurn.mockResolvedValue({ terminal: 'done', reply, toolCalls: [], iterations: 1 });

    const outcome = await runConversationTurn(request() as never);

    expect(outcome).toEqual({ kind: 'declined', reason });
    expect(recordSilence).toHaveBeenCalledWith(expect.objectContaining({ reason }));
    expect(deliver).not.toHaveBeenCalled();
  });
});

// ISS-1229 r41, judge-115: in a room the model wrote "- (nothing to add)" and "- Agreed.", and both were posted as
// bullet points; the first is the agent choosing to say nothing, the second a sentence.
describe('a reply written as a list item', () => {
  beforeEach(() => {
    runExternalChatTurn.mockReset();
    deliver.mockReset();
    recordSilence.mockReset();
  });

  const replying = (reply: string) =>
    runExternalChatTurn.mockResolvedValue({
      terminal: 'done',
      reply,
      toolCalls: [],
      iterations: 1,
    });

  it('declines a turn whose reply is the sentinel behind a list marker, posting nothing', async () => {
    replying('- (nothing to add)');

    const outcome = await runConversationTurn(request({ mayDecline: true }) as never);

    expect(outcome).toMatchObject({ kind: 'declined', reason: 'nothing-to-say' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('posts a reply that is one bulleted item as its sentence', async () => {
    replying('- Agreed.');

    const outcome = await runConversationTurn(request() as never);

    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect((deliver.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      text: 'Agreed.',
    });
  });
});
