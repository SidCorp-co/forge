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
