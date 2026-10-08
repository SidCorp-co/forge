// The web room's transport is the one place a held block is written into the room: only when the
// reply releasing it is delivered, as a row of its own just above that reply, and told to the room's
// readers then — never before (REQ-32 criteria 5 and 6).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedBlock } from '../lib/staged-block.js';

const rows: { content: string; blocks: unknown; authorUserId: string }[] = [];
const pushed: { event: string; data: { messageId?: string; content?: string } }[] = [];

vi.mock('../conversations/index.js', () => ({
  findConversation: async () => ({ id: 'c-1' }),
  handleForProject: async () => 'u-handle',
  listParticipants: async () => [{ kind: 'person', userId: 'u-reader' }],
  assertConversationReadable: async () => undefined,
  appendMessages: async (args: {
    messages: { content: string; blocks: unknown; authorUserId: string }[];
  }) => {
    rows.push(...args.messages);
    return [{ id: `m-${rows.length}` }];
  },
}));
vi.mock('../outbox/index.js', () => ({
  emitEvent: async (_db: unknown, _type: string, payload: (typeof pushed)[number]) => {
    pushed.push({ event: payload.event, data: payload.data });
  },
}));

const { webConversationPorts } = await import('./conversation-adapter.js');

const table: StagedBlock = {
  text: '| Requirement |',
  block: {
    type: 'visual',
    visual: { v: 1, kind: 'table', columns: ['key'], source: { runId: 'r' } },
  },
  kind: 'table',
  runId: 'r',
  projectId: 'p-1',
  askerUserId: 'u-asker',
};
const venue = { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' } as const;
const reply = { text: 'REQ-1 is agreed.', proof: null };

beforeEach(() => {
  rows.length = 0;
  pushed.length = 0;
});

describe('the web transport releases the blocks a reply carries', () => {
  it("writes each block as the handle's row and tells the room, before the reply", async () => {
    await webConversationPorts.deliver(venue, reply, { blocks: [table] });
    expect(rows).toEqual([
      { role: 'assistant', authorUserId: 'u-handle', content: table.text, blocks: [table.block] },
    ]);
    expect(pushed.map((p) => p.data.messageId ?? p.data.content)).toEqual([
      'm-1',
      expect.any(String),
    ]);
    expect(pushed[1]?.data.content).toBe(reply.text);
  });

  it('writes no block for a reply that carries none', async () => {
    await webConversationPorts.deliver(venue, reply);
    expect(rows).toEqual([]);
    expect(pushed).toHaveLength(1);
  });
});
