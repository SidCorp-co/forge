import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createChatSessionRow, transitionSessions } from '../../src/agent-sessions/index.js';
import { db } from '../../src/db/client.js';
import { agentSessions } from '../../src/db/schema.js';
import { conversations } from '../../src/db/schema-conversations.js';
import { api, type Body } from '../helpers/api.js';
import { type World, world } from '../helpers/forecast-world.js';

// An Agent-mode turn whose session ends without a reply reads in its room as what ended it (REQ-30
// BC-9, ISS-440): the session row is failed under a real cause through the session kernel, its
// completion bridge fires as it does in production, and the room's own read carries the sentence the
// bridge posted and the turn's next step. No box is paired, so a failover finds none and the
// reading is posted.

let w: World;
let roomId: string;
let externalId: string;

const FAILED = 'the door failure sentence (generic)';

async function agentTurnEndedAs(failureReason: 'agent_killed' | 'no_client_ack', waitedMs: number) {
  const windowId = randomUUID();
  const session = await createChatSessionRow({
    projectId: w.projectId,
    userId: w.userId,
    title: 'Chat: where does the export break?',
    runKind: 'system',
    metadata: {
      conversationAgent: {
        venue: { adapter: 'web', externalId, shape: 'direct', projectId: w.projectId },
        conversationId: roomId,
        windowId,
        deliveryKey: `window:${windowId}`,
        handleName: 'forge',
        question: 'where does the export break?',
        asker: { userId: w.userId, viaTokenId: null },
        door: 'web-agent-completion',
        replies: { dedup: 'd', noDevice: 'n', failed: FAILED, ack: null },
      },
    },
  });
  const dispatchedAt = new Date(Date.now() - waitedMs);
  await db
    .update(agentSessions)
    .set({ dispatchedAt, createdAt: dispatchedAt })
    .where(eq(agentSessions.id, session.id));
  await transitionSessions(db, {
    to: 'failed',
    set: { failureReason, updatedAt: new Date() },
    where: eq(agentSessions.id, session.id),
    reason: failureReason,
    actor: { type: 'sweeper' },
    source: 'agent-turn-failure-reads-e2e',
  });
  return { sessionId: session.id, windowId };
}

/** The room as its asker reads it, once the turn's bridge has posted into it. */
async function roomOnceSettled(windowId: string): Promise<{ messages: Body[]; turn: Body }> {
  for (let i = 0; i < 100; i++) {
    const room = (await api(w.token, 'GET', `/api/conversations/${roomId}`)).body;
    const turn = (room.agentTurns as Body[]).find((t) => t.windowId === windowId);
    if (turn?.state === 'failed') return { messages: room.messages as Body[], turn };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the turn of window ${windowId} never settled as failed`);
}

describe('an Agent turn that left no reply reads in its room as what ended it', () => {
  beforeAll(async () => {
    w = await world();
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'where does the export break',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    roomId = String(opened.body.id);
    const [row] = await db
      .select({ externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, roomId));
    externalId = String(row?.externalId);
  }, 120_000);

  it('a crashed session posts the crash and its next step, never the generic sentence', async () => {
    const { windowId } = await agentTurnEndedAs('agent_killed', 5_000);
    const { messages, turn } = await roomOnceSettled(windowId);
    const said = messages.map((m) => String(m.content));
    expect(said).toContain(
      "The Agent session crashed: it was killed by a signal. Send your message again: a new turn starts a fresh session. If it crashes again, the session's page in Forge names the cause.",
    );
    expect(said).not.toContain(FAILED);
    expect(turn.reason).toBe('the Agent session crashed: it was killed by a signal');
    expect(turn.nextStep).toMatch(/^Send your message again: a new turn starts a fresh session\./);
  });

  it('a timed-out turn posts the timeout naming the limit it hit, with its next step', async () => {
    const { windowId } = await agentTurnEndedAs('no_client_ack', 4 * 60_000);
    const { messages, turn } = await roomOnceSettled(windowId);
    const said = messages.map((m) => String(m.content));
    expect(said).toContain(
      'The Agent turn timed out: no box started a session for it within 3 minutes. Send your message again. If it times out again, check that forge-runner is running and online on the paired box.',
    );
    expect(said).not.toContain(FAILED);
    expect(turn.nextStep).toMatch(/If it times out again/);
  });
});
