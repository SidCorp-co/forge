// @direct-test-of packages/core/src/conversations/windows.ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createChatSessionRow, setSessionMarkerField } from '../../src/agent-sessions/index.js';
import { roomTail } from '../../src/assistant/read.js';
import { db } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema-conversations.js';
import { api } from '../helpers/api.js';
import { type World, world } from '../helpers/forecast-world.js';

// A room's read is one snapshot (REQ-79 cleanup): a turn's bridge stores its reply and then stamps
// the turn, so a read whose turns are newer than its messages showed a failed turn over a room that
// did not yet hold its reply, as agent-turn-failure-reads-e2e read in whole-suite run 41335608476.
// Here the turn is stamped, and committed, after the read has taken its messages: the turns the
// same read answers with must not see it.

let between: (() => Promise<void>) | null = null;

vi.mock('../../src/conversations/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/conversations/index.js')>();
  return {
    ...real,
    readMessages: async (...args: Parameters<typeof real.readMessages>) => {
      const read = await real.readMessages(...args);
      const write = between;
      between = null;
      if (write) await write();
      return read;
    },
  };
});

let w: World;
let roomId: string;
let externalId: string;

describe("a room's read answers with one snapshot", () => {
  beforeAll(async () => {
    w = await world();
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'one snapshot',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    roomId = String(opened.body.id);
    const [row] = await db
      .select({ externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, roomId));
    externalId = String(row?.externalId);
  }, 120_000);

  it('a turn stamped after the messages were read is not in that read, and is in the next', async () => {
    const windowId = randomUUID();
    const session = await createChatSessionRow({
      projectId: w.projectId,
      userId: w.userId,
      title: 'Chat: one snapshot',
      runKind: 'system',
      metadata: {
        conversationAgent: {
          venue: { adapter: 'web', externalId, shape: 'direct', projectId: w.projectId },
          conversationId: roomId,
          windowId,
          deliveryKey: `window:${windowId}`,
          handleName: 'forge',
          question: 'one snapshot?',
          asker: { userId: w.userId, viaTokenId: null },
          door: 'web-agent-completion',
          replies: { dedup: 'd', noDevice: 'n', failed: 'f' },
        },
      },
    });
    const stamped = 'stamped between the reads';
    between = () => setSessionMarkerField(session.id, 'conversationAgent', 'failure', stamped);

    const first = await roomTail(roomId, w.userId);
    expect(between, 'the read never took its messages through readMessages').toBeNull();
    const turn = first.agentTurns.find((t) => t.windowId === windowId);
    expect(turn?.state, JSON.stringify(turn)).not.toBe('failed');
    expect(turn?.reason).toBeNull();

    const next = (await roomTail(roomId, w.userId)).agentTurns.find((t) => t.windowId === windowId);
    expect(next?.state).toBe('failed');
    expect(next?.reason).toBe(stamped);
  });
});
