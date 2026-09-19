/**
 * ISS-1087 — `tool` mode and the sentinel prefix in the turn runner: the room hears
 * only what `room_send` captured, a turn that never called it is a named silence, and a
 * reply that begins with the sentinel is a decline. Split from `turn-runner.test.ts` for
 * the file budget; the mocks are the same shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenPasses } from '../messaging/screen-passes.fixture.js';

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

/** The neutral half of a transport: what the registry holds, and all a turn can reach. */
const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'server-id-9' }));
const fetchHistory = vi.fn(async (..._a: unknown[]) => []);

const VENUE = {
  adapter: 'widget' as const,
  externalId: 'venue-1',
  shape: 'group' as const,
  projectId: 'proj-1',
};

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

const REFUSAL = {
  rule: 'no-unverified-claims',
  why: 'names an issue no tool returned',
  quote: 'ISS-999',
  shape: 'only ids a tool returned',
  example: 'The fix is in review.',
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
  screenReplyAtDoor.mockImplementation(screenPasses);
  runExternalChatTurn.mockResolvedValue(answered);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tool mode: the room hears only what room_send captured (ISS-1087)', () => {
  type Tools = {
    tools: Array<{ function: { name: string } }>;
    execute: (n: string, a: string) => Promise<unknown>;
  };
  /** Run the model turn with a hand on its toolset, then answer with `reply` as the model's own prose. */
  const modelTurn = (use: (tools: Tools | undefined) => Promise<void>, reply = 'my own prose') =>
    runExternalChatTurn.mockImplementation(async (args: { tools?: Tools }) => {
      await use(args.tools);
      return { ...answered, reply };
    });
  const send = (text: string) => (tools: Tools | undefined) =>
    tools?.execute('room_send', JSON.stringify({ text })).then(() => undefined) ??
    Promise.resolve();

  it('delivers the captured text and never the prose (criteria 18, 20)', async () => {
    modelTurn(send('posted by the tool'));
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
    expect(deliver).toHaveBeenCalledWith(
      VENUE,
      expect.objectContaining({ text: 'posted by the tool' }),
      { addressee: null },
    );
    expect(screenReplyAtDoor.mock.calls[0]?.[1]).toMatchObject({
      segments: ['posted by the tool'],
    });
  });

  it('records tool-not-called and sends nothing when the model never calls it (criterion 19)', async () => {
    modelTurn(async () => undefined);
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'tool-not-called' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'tool-not-called' }),
    );
  });

  it('treats a captured sentinel as the decline it is (criterion 37)', async () => {
    modelTurn(send('(nothing to add)'));
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'nothing-to-say' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('offers room_send in tool mode only, and it owns its name', async () => {
    let offered: string[] = [];
    modelTurn(async (tools) => {
      offered = tools?.tools.map((t) => t.function.name) ?? [];
    });
    await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(offered).toEqual(['room_send']);
    offered = [];
    await runConversationTurn(request({ mayDecline: true }));
    expect(offered).toEqual([]);
  });

  it('never delivers a corrective retry’s prose when it did not call room_send (criterion 20)', async () => {
    screenReplyAtDoor.mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] });
    let attempt = 0;
    runExternalChatTurn.mockImplementation(async (args: { tools?: Tools }) => {
      attempt += 1;
      if (attempt === 1) await send('ISS-999 is fixed')(args.tools);
      return { ...answered, reply: 'admissible prose the retry wrote without the tool' };
    });
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'screen-refused' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'screen-refused' }),
    );
  });

  it('delivers what a corrective retry captured through its own room_send', async () => {
    screenReplyAtDoor.mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] });
    let attempt = 0;
    runExternalChatTurn.mockImplementation(async (args: { tools?: Tools }) => {
      attempt += 1;
      await send(attempt === 1 ? 'ISS-999 is fixed' : 'the fix is in review')(args.tools);
      return { ...answered, reply: 'prose' };
    });
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'delivered', messageId: 'server-id-9' });
    expect(deliver).toHaveBeenCalledWith(
      VENUE,
      expect.objectContaining({ text: 'the fix is in review' }),
      { addressee: null },
    );
  });

  it('treats a corrective retry that declines through room_send as silence (criterion 37)', async () => {
    screenReplyAtDoor.mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] });
    let attempt = 0;
    runExternalChatTurn.mockImplementation(async (args: { tools?: Tools }) => {
      attempt += 1;
      await send(attempt === 1 ? 'ISS-999 is fixed' : '(nothing to add) — sorry')(args.tools);
      return { ...answered, reply: 'prose' };
    });
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'nothing-to-say' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'nothing-to-say' }),
    );
  });

  it('streams none of the model’s prose to a watcher in tool mode', async () => {
    const onTurnEvent = vi.fn();
    modelTurn(send('posted by the tool'));
    await runConversationTurn(request({ sendMode: 'tool', mayDecline: true, onTurnEvent }));
    expect(runExternalChatTurn.mock.calls[0]?.[0]).not.toHaveProperty('onTurnEvent');
    await runConversationTurn(request({ mayDecline: true, onTurnEvent }));
    expect(runExternalChatTurn.mock.calls[1]?.[0]).toHaveProperty('onTurnEvent');
  });

  it('posts no fallback when the turn fails before anything was captured (criterion 19)', async () => {
    const out = await runConversationTurn(
      request({
        sendMode: 'tool',
        mayDecline: true,
        prepare: async () => {
          throw new Error('history unreachable');
        },
      }),
    );
    expect(out).toEqual({ kind: 'declined', reason: 'turn-failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(expect.objectContaining({ reason: 'turn-failed' }));
  });

  it('refuses `null` arguments to room_send by name, and the turn is tool-not-called', async () => {
    let refusal: unknown;
    modelTurn(async (tools) => {
      refusal = await tools?.execute('room_send', 'null');
    });
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(JSON.stringify(refusal)).toMatch(/not a JSON object/);
    expect(out).toEqual({ kind: 'declined', reason: 'tool-not-called' });
  });

  it('persists nothing from the model turn in tool mode, and files a failed turn once', async () => {
    modelTurn(send('posted by the tool'));
    await runConversationTurn(
      request({ sendMode: 'tool', mayDecline: true, questionAlreadyRecorded: true }),
    );
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      record: 'nothing',
      questionInHistory: true,
    });
    await runConversationTurn(request({ mayDecline: true, questionAlreadyRecorded: true }));
    expect(runExternalChatTurn.mock.calls[1]?.[0]).toMatchObject({ record: 'silence-only' });
    runExternalChatTurn.mockResolvedValue({
      ...answered,
      reply: '',
      terminal: 'error',
      error: 'provider exploded',
    });
    const out = await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'provider exploded' });
    expect(recordSilence).toHaveBeenCalledTimes(1);
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'provider exploded' }),
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('keeps the first message when room_send is called twice', async () => {
    modelTurn(async (tools) => {
      await tools?.execute('room_send', JSON.stringify({ text: 'first' }));
      await tools?.execute('room_send', JSON.stringify({ text: 'second' }));
    });
    await runConversationTurn(request({ sendMode: 'tool', mayDecline: true }));
    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ text: 'first' }), {
      addressee: null,
    });
  });
});

describe('a reply that begins with the sentinel (ISS-1087)', () => {
  it('is silence, with nothing sent to the room (criterion 38)', async () => {
    runExternalChatTurn.mockResolvedValue({
      ...answered,
      reply: '(nothing to add) — though you may want to check the build',
    });
    const out = await runConversationTurn(request({ mayDecline: true }));
    expect(out).toEqual({ kind: 'declined', reason: 'nothing-to-say' });
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSilence).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'nothing-to-say' }),
    );
  });

  it('is an answer when the sentinel only follows other text (criterion 23)', async () => {
    runExternalChatTurn.mockResolvedValue({
      ...answered,
      reply: 'The build is green. (nothing to add)',
    });
    const out = await runConversationTurn(request({ mayDecline: true }));
    expect(out).toMatchObject({ kind: 'delivered' });
  });
});
