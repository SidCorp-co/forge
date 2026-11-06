import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, type Body } from '../helpers/api.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/feedback/confirm-wait.ts
// @direct-test-of packages/core/src/support/inbound.ts
//
// ISS-1038 (FB-536, sidpeak FB-4): a wait on a room message was ended by any member message in any
// support room of the project, and the item kept only the time, so the master could not tell what
// ended it. Through the room's own doors: the item is recorded from a thread, shipped, and its master
// sets a wait on the next room message naming no thread. A message in another thread leaves it; one
// in the item's thread ends it, and the item carries that message.

const w = new SupportWorld();

/** The project's master: an agent credential that writes the project. */
async function masterToken(): Promise<string> {
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(w.projectId, agent);
  return (
    await mintPat({
      permissions: ['*'],
      userId: agent,
      name: 'master',
      projectIds: [w.projectId],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
}
let master = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

/** bob reports in a new thread, the session records it, and bob agrees: the item and its thread. */
async function recordedFromThread(text: string): Promise<{ thread: string; key: string }> {
  await w.settleWarm();
  let proposal = '';
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || !m.text.startsWith(text)) continue;
      const out = await act({
        action: 'record',
        thread: m.thread,
        kind: 'defect',
        title: `Fix: ${text}`,
        summary: text,
      });
      proposal = String(out.proposal);
    }
  };
  const thread = await w.chat.say(w.chat.bob, text);
  await expect.poll(() => proposal, { timeout: 15_000 }).not.toBe('');
  const agreed = await w.agreeBy(w.chat.bob, 'yes, record it', thread, proposal);
  expect(agreed.out, JSON.stringify(agreed.out)).toMatchObject({ recorded: true });
  return { thread, key: String(agreed.out.feedbackKey) };
}

/** The item shipped: triaged onto an issue that closed with a merge, as its fix landing reads. */
async function ship(key: string): Promise<void> {
  const carrier = await createTestIssue(w.projectId, w.ownerId, 1038, {
    status: 'closed',
    createdAt: new Date(Date.now() - 3_600_000),
    mergedAt: new Date(Date.now() - 60_000),
  });
  // a person's triage moves it, as the kernel's marker records
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
    WITH f AS (
      UPDATE feedback SET status = 'triaged', route = 'issue'
       WHERE project_id = ${w.projectId} AND fb_seq = ${Number(key.slice(3))} RETURNING id
    )
    INSERT INTO feedback_route_issues (feedback_id, issue_id) SELECT id, ${carrier.id} FROM f
  `),
  );
}

const item = async (key: string): Promise<Body> => {
  const res = await api(master, 'GET', `/api/projects/${w.projectId}/feedback/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
};

/** `who` writes `text` in `thread` (a new one when absent), as nobody's act; its id once recorded. */
async function sayAndRecord(text: string, thread?: string): Promise<string> {
  w.box.model = async () => {};
  const id = await w.chat.say(w.chat.alice, text, thread);
  await expect
    .poll(
      async () =>
        (
          await rows<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM support_actions
             WHERE project_id = ${w.projectId}::uuid AND kind = 'message_in' AND external_id = ${id}`)
        )[0]?.n ?? 0,
      { timeout: 15_000 },
    )
    .toBe(1);
  await w.settleWarm();
  return id;
}

describe('ISS-1038: only a message in the item’s own thread ends its wait, and the item keeps it', () => {
  it('leaves the wait on a message elsewhere, ends it on one in its thread, and the item carries that message', async () => {
    const { thread, key } = await recordedFromThread('The payslip export is blank');
    await ship(key);
    master = await masterToken();
    const set = await api(
      master,
      'POST',
      `/api/projects/${w.projectId}/feedback/${key}/confirm-wait`,
      {
        until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        on: 'room_message',
        reason: 'bob’s next word in his thread tests the fix',
      },
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // the wait names the thread the item was recorded from
    expect((set.body.feedback as Body).confirmWait).toMatchObject({
      on: 'room_message',
      room: { rid: w.chat.rid, thread },
    });

    // a message in another thread of the same room is about something else: the wait stands
    await sayAndRecord('Is the release for 620 out yet?');
    expect((await item(key)).confirmWait).toMatchObject({ on: 'room_message' });
    expect((await item(key)).confirmWaitMet).toBeNull();

    // the next message in the item's own thread ends it, and the item says which message it was
    const id = await sayAndRecord('Export works now, thank you', thread);
    const after = await item(key);
    expect(after.confirmWait).toBeNull();
    expect(after.confirmWaitMet).toMatchObject({
      message: id,
      rid: w.chat.rid,
      thread,
      author: 'alice',
      text: 'Export works now, thank you',
    });
  });
});
