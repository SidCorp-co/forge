import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/direct-turn.ts
 * @direct-test-of packages/core/src/support/direct-asker.ts
 * @direct-test-of packages/core/src/agent-sessions/room-direct-turn.ts
 * @direct-test-of packages/core/src/agent-sessions/interactive-routes.ts
 */

// ISS-950: the owner asked adminhub-api's channel session a question straight to the session, and
// it answered that every production read was blocked, since those run only while it answers in the
// room. A direct send ran as a web chat turn under a token minted for the sender, which no room act
// admits. It now runs as the room's turn, with the room's grants; anyone below project admin is
// refused by name and nothing runs.

const READS = [
  {
    name: 'orders-today',
    summary: "Count today's orders on production",
    argv: ['/usr/local/bin/hub-data', 'orders', '--today'],
  },
];

const w = new SupportWorld();
let sessionId = '';

beforeAll(async () => {
  await w.start();
  const chat = w.chat as StandInRocketChat;
  await w.bindTarget({
    rids: [chat.rid],
    agent: {
      product: 'AdminHub, the supplier and order back office',
      readers: 'team',
      grants: { abilities: ['ops_reads'], owner: 'u-alice', reads: READS },
    },
  });
  await w.settleWarm();
  sessionId = String((await w.rooms())[0]?.sessionId);
}, 120_000);

afterAll(() => w.stop());

const send = (token: string, body: Record<string, unknown>) =>
  api(token, 'POST', '/api/agent-sessions/send', { sessionId, ...body });

describe("ISS-950: a direct message to a room's session runs with the room's grants", () => {
  it("answers the owner's direct question with a production read, as the room's turn", async () => {
    let out: Record<string, unknown> | null = null;
    let text = '';
    w.box.model = async (turn, act) => {
      if (!turn.text.includes('How many orders came in today?')) return;
      text = turn.text;
      out = await act({ action: 'read', name: 'orders-today' });
    };
    const sent = await send(w.owner, { message: 'How many orders came in today?' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect.poll(() => out, { timeout: 20_000 }).not.toBeNull();
    const got = out as unknown as Record<string, unknown>;
    // [DIRECT_TURN_UNGRANTED] before the fix: SUPPORT_NOT_THE_ROOM_SESSION, the sender's token
    expect(refusalCodes(got), JSON.stringify(got)).toEqual([]);
    expect(got.isError).toBe(false);
    expect(w.box.acts.filter((a) => a.event === 'ops.read')).toHaveLength(1);
    // the session reads who sent it and whom an act runs as
    expect(text).toContain('A direct message from');
    expect(text).toMatch(/names thread `direct` and message `[0-9a-f-]{36}`/);
    await w.settleWarm();
  });

  it('refuses a member below project admin by name, and hands the session nothing', async () => {
    const member = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, member.id, 'member');
    const turns = w.box.turns.length;
    const sent = await send(await userToken(member.id), { message: 'what broke last night?' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(403);
    expect(JSON.stringify(sent.body)).toContain('SESSION_OWNER_FORBIDDEN');
    await new Promise((r) => setTimeout(r, 500));
    expect(w.box.turns.length).toBe(turns);
  });

  it('refuses a direct message carrying files by name, and hands the session nothing', async () => {
    const turns = w.box.turns.length;
    const sent = await send(w.owner, {
      message: 'see the screenshot',
      attachmentIds: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(400);
    expect(JSON.stringify(sent.body)).toContain('SUPPORT_DIRECT_TURN_SHAPE');
    expect(w.box.turns.length).toBe(turns);
  });
});
