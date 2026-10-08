// A turn whose box cannot confine a chat is its own outcome (REQ-30 BC-9, chat-turn step noconfine,
// ISS-440): its session records `box_cannot_confine_chat`, never `dispatch_failed`; the caller gets the
// refusal's own sentence naming the box and why; and the stamped marker keeps the completion bridge
// from failing it over to another box or posting the generic "session ended" sentence beside it.
// The session kernel is a fake; the refusal is the one `agent-sessions/chat-device.ts` throws.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseSession } from '../agent-sessions/refusals.js';

const transitions: Array<{ to: string; set: Record<string, unknown>; reason: string }> = [];
let dispatchThrows: unknown = null;

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../agent-sessions/index.js', () => ({
  pickTurnCredentialDevice: async () => 'd-1',
  noTurnCredentialDeviceReason: async () => 'no-device',
  resolveSessionAuthority: async () => ({ ok: true, value: { authority: {}, menu: [] } }),
  createChatSessionRow: async (input: { metadata: Record<string, unknown> }) => ({
    id: 's-1',
    metadata: input.metadata,
  }),
  mintSessionCredential: async () => 'turn-token',
  dispatchChatTurn: async () => {
    if (dispatchThrows) throw dispatchThrows;
    return { id: 's-1' };
  },
  transitionSessions: async (
    _db: unknown,
    t: { to: string; set: Record<string, unknown>; reason: string },
  ) => {
    transitions.push(t);
    return { rows: [] };
  },
}));
vi.mock('../lib/data-egress.js', () => ({
  egressShown: async (_p: string, _k: string, shown: Record<string, unknown>) => shown,
}));
vi.mock('../issues/index.js', () => ({
  computeProjectProgress: async () => null,
  buildProgressFactsBlock: () => '',
}));
vi.mock('./conversation-agent-read.js', () => ({
  hasInFlightConversationAgentTurn: async () => false,
}));
vi.mock('./conversation-agent-ack.js', () => ({ scheduleAck: () => undefined }));

const { startConversationAgentTurn, notDispatchedCause } = await import('./conversation-agent.js');

const REFUSAL =
  'A chat session holds only its own turn credential, and the runner box mac-mini cannot confine one, so nothing was dispatched: runs macos.';

function turn() {
  return startConversationAgentTurn({
    venue: { adapter: 'web', externalId: 'room', shape: 'direct', projectId: 'p-1' },
    conversationId: 'c-1',
    windowId: 'w-1',
    deliveryKey: 'window:w-1',
    project: { id: 'p-1', slug: 'p' },
    handleName: 'forge',
    question: 'where does the export break?',
    asker: { userId: 'u-1', viaTokenId: null },
    persona: 'persona',
    door: 'web-agent-completion',
    replies: { dedup: 'd', noDevice: 'n', failed: 'f', ack: null },
  });
}

beforeEach(() => {
  transitions.length = 0;
  dispatchThrows = null;
});

describe('a box that cannot confine a chat', () => {
  it('is its own outcome, carrying the refusal sentence that names the box and why', async () => {
    dispatchThrows = refuseSession('BOX_CANNOT_CONFINE_CHAT', REFUSAL);
    expect(await turn()).toEqual({
      started: false,
      reason: 'box-cannot-confine',
      message: REFUSAL,
    });
  });

  it('fails its session box_cannot_confine_chat with the marker stamped delivered, so no bridge answers or fails it over', async () => {
    dispatchThrows = refuseSession('BOX_CANNOT_CONFINE_CHAT', REFUSAL);
    await turn();
    expect(transitions).toHaveLength(1);
    const [t] = transitions;
    expect(t?.to).toBe('failed');
    expect(t?.reason).toBe('box_cannot_confine_chat');
    expect(t?.set.failureReason).toBe('box_cannot_confine_chat');
    const marker = (t?.set.metadata as { conversationAgent?: Record<string, unknown> })
      ?.conversationAgent;
    expect(marker?.deliveredAt).toEqual(expect.any(String));
    expect(marker?.failure).toBe(REFUSAL);
  });

  it('is named the same way by a failover or a room escalation that meets it', () => {
    expect(notDispatchedCause(refuseSession('BOX_CANNOT_CONFINE_CHAT', REFUSAL))).toBe(
      'box_cannot_confine_chat',
    );
    expect(notDispatchedCause(refuseSession('CHECKOUT_UNBOUND', 'x'))).toBe('checkout_unbound');
    expect(notDispatchedCause(new Error('socket closed'))).toBe('dispatch_failed');
  });

  it('leaves any other hand-over failure to the bridge, unstamped, as dispatch_failed', async () => {
    dispatchThrows = new Error('socket closed');
    expect(await turn()).toEqual({ started: false, reason: 'dispatch-failed' });
    expect(transitions.map((t) => [t.reason, t.set.metadata])).toEqual([
      ['dispatch_failed', undefined],
    ]);
  });
});
