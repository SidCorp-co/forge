import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { supportMaster } from '../helpers/support-master.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/conversations/handles.ts
// @direct-test-of packages/core/tests/helpers/support-master.ts
// @direct-test-of packages/core/tests/helpers/support-world.ts
//
// ISS-1041: ISS-1038's build saw a support room's first member message never land when the
// project's master account joined the project before it. The account was a bare agent user the test
// added as a member, with no org membership and so no handle: the oldest agent member of the project
// alone is its handle (`existingProjectHandle`), so the thread's conversation was refused
// HANDLE_HAS_NO_NAME and the message dropped. No door makes that account: a master is the project's
// own agent, minted with a handle. Here the master joins before the room hears anything, made as the
// product makes it, and the first member message lands, opens its thread on the master's handle and
// reaches the session; the world fails any run in which a member message is dropped.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1041: a master that joined first leaves the first member message to land', () => {
  it('records the first message after the master joined, on a thread opened with its handle, and hands it to the session', async () => {
    const master = await supportMaster(w.projectId);
    await w.settleWarm();
    const heard: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') heard.push(m.text);
    };
    const text = 'The payslip export is blank';
    const id = await w.chat.say(w.chat.alice, text);
    const taken = () =>
      rows<{ conversation_id: string }>(sql`
        SELECT conversation_id FROM support_actions
         WHERE project_id = ${w.projectId}::uuid AND kind = 'message_in' AND external_id = ${id}`);
    await expect.poll(async () => (await taken()).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => heard.some((t) => t.includes(text)), { timeout: 15_000 }).toBe(true);
    // the thread opened with the master's own agent as the project's handle, never a second one
    const [conversation] = await taken();
    const handles = await rows<{ user_id: string }>(sql`
      SELECT user_id FROM conversation_participants
       WHERE conversation_id = ${conversation?.conversation_id}::uuid AND kind = 'handle'`);
    expect(handles.map((h) => h.user_id)).toEqual([master.userId]);
    expect(w.dropped).toEqual([]);
  });
});
