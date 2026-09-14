/**
 * ISS-1002 — a transport's own message carried to a delivered turn, over four
 * port functions and nothing else.
 *
 * This is the claim the issue is about: a second adapter is `resolveVenue`,
 * `resolveSpeaker`, `deliver` and `fetchHistory`. Every case here builds one
 * object with exactly those four, hands it a frame, and asserts what the venue
 * was shown — so a turn that came to need a fifth function, or a callback
 * alongside them, could not keep these passing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../observability/sentry.js', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
vi.mock('./transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [never])),
}));

vi.mock('../messaging/reply-screen.js', () => ({ screenReplyAtDoor: async () => ({ ok: true }) }));

const { runInboundTurn } = await import('./inbound-turn.js');
const { clearConversationTransports, registerConversationTransport } = await import('./ports.js');
type ConversationAdapterPorts<F> = import('./ports.js').ConversationAdapterPorts<F>;

/** What this transport calls a message. Nothing outside this file knows its shape. */
interface Frame {
  room: string;
  who: string;
  oneToOne: boolean;
}

const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'server-id-9' }));

function adapter(
  over: Partial<ConversationAdapterPorts<Frame>> = {},
): ConversationAdapterPorts<Frame> {
  return {
    adapter: 'widget',
    deliver,
    fetchHistory: async () => [],
    resolveVenue: async (frame) => ({
      adapter: 'widget' as const,
      externalId: frame.room,
      shape: frame.oneToOne ? ('direct' as const) : ('group' as const),
      projectId: 'proj-1',
    }),
    resolveSpeaker: async (frame) => ({ linked: true, userId: `forge:${frame.who}` }),
    ...over,
  };
}

const inbound = (ports: ConversationAdapterPorts<Frame>, frame: Frame) => ({
  ports,
  frame,
  message: 'How does the pipeline work?',
  speakerKey: frame.who,
  manySpeakersPrincipalUserId: 'the-binding-principal',
  turn: { door: 'chat-sync' as const, handleName: 'Babo' },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearConversationTransports();
  deliver.mockResolvedValue({ messageId: 'server-id-9' });
  runExternalChatTurn.mockResolvedValue({
    conversationId: 'conv-1',
    assistantMessageId: null,
    reply: 'an answer',
    terminal: 'done',
    error: null,
    iterations: 1,
    toolCalls: [],
    progress: null,
  });
});

describe('a frame carried on four port functions', () => {
  it('reaches a delivered transcript row with no callback of the adapter own', async () => {
    const ports = adapter();
    registerConversationTransport(ports);

    const outcome = await runInboundTurn(
      inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: false }),
    );

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'an answer' });
    expect(recordDeliveredReply.mock.calls[0]?.[0]).toMatchObject({ text: 'an answer' });
    expect(outcome).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
  });
});

describe('whose authority the turn runs under', () => {
  // cm:guard a one-to-one venue has exactly one human and runs as them: answering it under the binding's principal would answer a stranger with somebody else's read access (ISS-987, consuming ISS-977).
  it('runs a one-to-one venue as the speaker the port resolved', async () => {
    const ports = adapter();
    registerConversationTransport(ports);

    await runInboundTurn(inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: true }));

    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({ userId: 'forge:ana' });
  });

  // cm:guard a many-speaker venue resolves NO speaker at all: it has no single authority to run as, and pointing it at whoever spoke last would change whose access the room sees between two messages.
  it('runs a many-speaker venue as the binding principal, asking the speaker port nothing', async () => {
    const resolveSpeaker = vi.fn();
    const ports = adapter({ resolveSpeaker });
    registerConversationTransport(ports);

    await runInboundTurn(inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: false }));

    expect(resolveSpeaker).not.toHaveBeenCalled();
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      userId: 'the-binding-principal',
    });
  });
});

describe('the two ways a frame never becomes a turn', () => {
  // cm:guard the refusal opens no conversation: a speaker nobody could name must leave no row behind for a turn that was never had (ISS-1001).
  // cm:guard and it goes out the SAME door an answer would have, so an adapter needs no second outbound path of its own for an authority refusal (ISS-1002 review).
  it('delivers the speaker port own refusal through the one door, and opens nothing', async () => {
    const ports = adapter({
      resolveSpeaker: async () => ({
        linked: false,
        refusal: {
          code: 'SPEAKER_UNLINKED',
          message: 'link yourself here, at these two endpoints',
        },
      }),
    });
    registerConversationTransport(ports);

    const outcome = await runInboundTurn(
      inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: true }),
    );

    expect(outcome).toEqual({
      kind: 'speaker-refused',
      code: 'SPEAKER_UNLINKED',
      refusal: 'link yourself here, at these two endpoints',
      delivered: true,
    });
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      text: 'link yourself here, at these two endpoints',
    });
    expect(openConversation).not.toHaveBeenCalled();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });

  it('says the refusal was not delivered when the door refuses that too', async () => {
    const ports = adapter({
      resolveSpeaker: async () => ({
        linked: false,
        refusal: { code: 'SPEAKER_UNLINKED', message: 'link yourself here' },
      }),
    });
    registerConversationTransport(ports);
    deliver.mockRejectedValue(new Error('the room is bound to another project now'));

    const outcome = await runInboundTurn(
      inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: true }),
    );

    expect(outcome).toMatchObject({ kind: 'speaker-refused', delivered: false });
  });

  // cm:guard a frame that cannot be placed does NOT borrow the speaker's refusal to have something to say: that names a problem a many-speaker venue does not have — it never consults the speaker's identity — and offers a repair that would not help. An adapter that owes its reader a reason for this fault owes one written for it (ISS-1002 review).
  it('names only the placement failure, and asks the speaker port nothing', async () => {
    const resolveSpeaker = vi.fn();
    const ports = adapter({ resolveVenue: async () => null, resolveSpeaker });
    registerConversationTransport(ports);

    const outcome = await runInboundTurn(
      inbound(ports, { room: 'venue-1', who: 'ana', oneToOne: false }),
    );

    expect(outcome).toEqual({ kind: 'venue-unresolved' });
    expect(resolveSpeaker).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
