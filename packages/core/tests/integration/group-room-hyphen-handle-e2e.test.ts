/**
 * QA of ISS-425 on dev.185 (eco-a): every message in a group room was answered "unreachable",
 * because `presence.ts` escaped the hyphen of the handle `eco-a` as `\-` and compiled it under the
 * `u` flag, where that is an invalid escape, so every group-room window threw before a turn was
 * spent. 04400552b fixed the escape; this holds it end to end. A test project's handle is minted
 * from its slug (`test-<id>`), so it carries a hyphen as eco-a's did; the room has two people, so it
 * is `group`, and both messages go through the real send route and the real window routing. The
 * model is the one thing scripted.
 */

import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const REPLY = 'I am here, reading along.';
const turns: string[] = [];

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModelName: () => 'scripted',
}));

vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async (args: { conversationId: string }) => {
    turns.push(args.conversationId);
    return {
      conversationId: args.conversationId,
      reply: REPLY,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
      progress: null,
    };
  },
}));

const { db } = await import('../../src/db/client.js');
const { conversationMessages, conversationWindows } = await import(
  '../../src/db/schema-conversations.js'
);
const { claimDueWindows, claimOf, roomHandles } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let projectId = '';
let ownerToken = '';
let colleague = '';

interface Room {
  id: string;
  externalId: string;
  shape: 'direct' | 'group';
}

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
});

async function send(room: Room, content: string): Promise<void> {
  const res = await api(ownerToken, 'POST', `/api/conversations/${room.id}/messages`, { content });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Route whatever window the room still owes, as the next send or the recovery drain would. */
async function routeOwed(room: Room): Promise<void> {
  for (;;) {
    const [window] = await claimDueWindows({
      adapter: 'web',
      claimant: 'hyphen-probe',
      limit: 1,
      venuePrefixes: [room.externalId],
      settleMs: 0,
    });
    if (!window) return;
    const claim = claimOf(window);
    if (claim) await routeWebWindow(window, claim);
  }
}

async function decisions(id: string) {
  return db
    .select({ decision: conversationWindows.decision, detail: conversationWindows.decisionDetail })
    .from(conversationWindows)
    .where(eq(conversationWindows.conversationId, id));
}

describe('a group room in a project whose handle has a hyphen', () => {
  for (const [said, content] of [
    ['naming the handle', (handle: string) => `@${handle} how far is REQ-1?`],
    ['not naming it', () => 'How far is REQ-1?'],
  ] as const) {
    it(`is heard, and answered, on a message ${said}`, async () => {
      const res = await api(ownerToken, 'POST', '/api/conversations', {
        projectId,
        title: `hyphen ${said}`,
        people: [colleague],
      });
      expect(res.status).toBe(201);
      const room = res.body as unknown as Room;
      expect(room.shape).toBe('group');
      const [handle] = await roomHandles(room.id);
      expect(handle?.handle, 'the minted handle carries a hyphen, as eco-a does').toMatch(/-/);

      const before = turns.length;
      await send(room, content(handle?.handle ?? ''));
      await routeOwed(room);

      const closed = await decisions(room.id);
      expect(closed.length).toBeGreaterThan(0);
      expect(
        closed.filter((w) => w.decision === 'unreachable'),
        JSON.stringify(closed),
      ).toEqual([]);
      expect(
        closed.map((w) => w.decision),
        JSON.stringify(closed),
      ).toContain('answered');
      expect(turns.length).toBe(before + 1);
      const rows = await db
        .select({ role: conversationMessages.role, content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, room.id))
        .orderBy(asc(conversationMessages.seq));
      expect(rows.at(-1)).toEqual({ role: 'assistant', content: REPLY });
    });
  }
});
