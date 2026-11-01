// ISS-857 (owner ruling agent-is-the-voice): a runner-hosted conversation turn that is still running
// is not covered by a line core wrote. A session marker that still carries an old `ack` text (a row
// written before this change, read again by a failover) posts nothing either.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const delivered: string[] = [];

vi.mock('../db/client.js', () => {
  const rows = [{ status: 'running', metadata: {} }];
  const chain = { from: () => chain, where: () => chain, limit: async () => rows };
  return { db: { select: () => chain } };
});
vi.mock('./ports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ports.js')>()),
  conversationTransport: () => ({
    deliver: async (_venue: unknown, message: { text: string }) => {
      delivered.push(message.text);
      return { messageId: 'm-1' };
    },
  }),
}));
vi.mock('../agent-sessions/index.js', () => ({
  pickTurnCredentialDevice: async () => 'd-1',
  noTurnCredentialDeviceReason: async () => 'no-device',
  resolveSessionAuthority: async () => ({ ok: true, value: { authority: {}, menu: [] } }),
  createChatSessionRow: async (input: { metadata: Record<string, unknown> }) => ({
    id: 's-1',
    metadata: input.metadata,
  }),
  mintSessionCredential: async () => 'turn-token',
  dispatchChatTurn: async () => ({ id: 's-1' }),
  transitionSessions: async () => ({ rows: [] }),
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

const { startConversationAgentTurn } = await import('./conversation-agent.js');

beforeEach(() => {
  delivered.length = 0;
});

describe('a runner-hosted turn still running', () => {
  it('posts no interim line core wrote, whatever its marker carries', async () => {
    const result = await startConversationAgentTurn({
      venue: { adapter: 'rocketchat', externalId: 'ns r-1', shape: 'group', projectId: 'p-1' },
      conversationId: 'c-1',
      windowId: 'w-1',
      deliveryKey: 'window:w-1',
      project: { id: 'p-1', slug: 'p' },
      handleName: 'forge',
      question: 'where does the export break?',
      asker: { userId: 'u-1', viaTokenId: null },
      persona: 'persona',
      door: 'agent-chat-completion',
      // an older caller's shape: an ack text and the delay after which it was posted
      replies: { dedup: 'd', noDevice: 'n', failed: 'f', ack: 'Still working on it…' },
      ackAfterMs: 1,
    } as never);
    expect(result).toMatchObject({ started: true });
    await new Promise((r) => setTimeout(r, 40));
    expect(delivered).toEqual([]);
  });
});
