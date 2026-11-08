import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { readMasterWork } from '../../src/masters/owed.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/masters/owed.ts
//
// ISS-1046: a member message whose handling threw was dropped with a server log alone: no record
// row, the person heard nothing and the master was never told. Planted with ISS-1041's shape, a bare
// agent member that joined the project before any handle (no door makes one, old data can), whose
// first message is refused HANDLE_HAS_NO_NAME when its thread's conversation opens. The message is
// now recorded on the room as received but not handled, with its code; the person is told in their
// thread that it is kept; and the master's nudge names the room and the cause, once for both.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1046: a member message the room cannot take is never lost silently', () => {
  it('records it with its code, tells the person in their thread, and names it once on the master’s nudge', async () => {
    const bare = await createTestUser({ kind: 'agent' });
    await addProjectMember(w.projectId, bare.id, 'member');
    await w.settleWarm();
    const first = await w.chat.say(w.chat.alice, 'The payslip export is blank');
    const second = await w.chat.say(w.chat.alice, 'Still blank today');
    const unhandled = () =>
      rows<{ thread: string; code: string; message: string }>(sql`
        SELECT thread, output->>'code' AS code, input->>'message' AS message FROM support_actions
         WHERE project_id = ${w.projectId}::uuid AND kind = 'refused' AND tool = 'message_unhandled'
         ORDER BY created_at`);
    await expect.poll(async () => (await unhandled()).length, { timeout: 15_000 }).toBe(2);
    expect(await unhandled()).toEqual([
      { thread: first, code: 'HANDLE_HAS_NO_NAME', message: first },
      { thread: second, code: 'HANDLE_HAS_NO_NAME', message: second },
    ]);
    // the person is told in the thread that the message is kept, never asked to send it again
    await expect
      .poll(() => w.chat.linesIn(w.chat.rid).filter((l) => l.tmid === first).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const [runner] = await rows<{ device_id: string }>(
      sql`SELECT device_id FROM runners WHERE project_id = ${w.projectId}::uuid LIMIT 1`,
    );
    const work = await readMasterWork(String(runner?.device_id), w.projectId);
    // one cause, one line: both messages counted on it, not one line each
    expect(work.owedLine).toContain(`2 in room ${w.chat.rid}, HANDLE_HAS_NO_NAME`);
    expect(work.owedLine.match(/could not take member messages/g)).toHaveLength(1);
    expect(w.dropped).toEqual([]);
  });
});
