import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-approves.ts
// @direct-test-of packages/core/src/support/propose.ts
// @direct-test-of packages/core/src/feedback/external.ts
//
// ISS-1243: 16 of 79 bot records in adminhub-api, adminhub-fe and catalog-api were the owner's
// approvals ("chuongld cho lên production…", "đồng ý MR…") filed as new Feedback beside the item
// they approved; thread BeK4G held FB-15..19 of two projects. The owner's approval attaches to the
// open item of the thread; a record he asks for there is refused until it says it is separate work.
// alice is the owner the binding names (support-agent-world's OWNER_ID).

const w = new AgentWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
}, 120_000);

afterAll(() => w.stop());

const feedbackCount = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
    )
  )[0]?.n ?? 0;

describe('ISS-1243: an owner approval attaches to the item it approves', () => {
  it('refuses a record of his approval, attaches it to the open item, and files nothing new', async () => {
    // the owner asks for an export and it is recorded from the thread
    let pending: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(chat.alice, 'Add a CSV export of refunds please'),
      async (_t, act, message) => {
        pending = await act({
          action: 'record',
          thread: message().thread,
          kind: 'feature',
          title: 'CSV export of refunds',
          summary: 'The owner wants refunds exported as CSV.',
        });
      },
    );
    expect(pending, JSON.stringify(pending)).toMatchObject({ pending: true });
    const filed = await w.agreeBy(chat.alice, 'yes', asked.id, String(pending.proposal));
    expect(filed.out, JSON.stringify(filed.out)).toMatchObject({ recorded: true });
    const key = String(filed.out.feedbackKey);
    const before = await feedbackCount();
    // later, in the same thread, the owner approves it
    let record: Record<string, unknown> = {};
    let approved: Record<string, unknown> = {};
    let notHis: Record<string, unknown> = {};
    let unknown: Record<string, unknown> = {};
    const bobs = await w.hear(
      () => chat.say(chat.bob, 'any update on the refunds export?', asked.id),
      async (_t, act, message) => {
        await act({
          action: 'silent',
          thread: message().thread,
          message: message().message,
          reason: 'asks for an update, which the record answers',
        });
      },
    );
    const go = await w.hear(
      () => chat.say(chat.alice, 'ok cho lên production luôn', asked.id),
      async (_t, act, message) => {
        const m = message();
        record = await act({
          action: 'record',
          thread: m.thread,
          kind: 'request',
          title: 'Release the refunds export to production',
          summary: 'The owner approved the refunds export for production.',
        });
        notHis = await act({
          action: 'approve',
          thread: m.thread,
          message: bobs.id,
          feedback: key,
        });
        unknown = await act({
          action: 'approve',
          thread: m.thread,
          message: String(m.message),
          feedback: 'FB-999999',
        });
        approved = await act({
          action: 'approve',
          thread: m.thread,
          message: String(m.message),
          feedback: key,
        });
      },
    );
    // [APPROVAL_FILED_AS_NEW] before the fix: the record was proposed, and filed on his word
    expect(code(record), JSON.stringify(record)).toBe('SUPPORT_RECORD_IS_APPROVAL');
    expect(JSON.stringify(record)).toContain(key);
    expect(code(notHis), JSON.stringify(notHis)).toBe('SUPPORT_APPROVAL_NOT_THE_OWNERS');
    expect(code(unknown), JSON.stringify(unknown)).toBe('SUPPORT_APPROVAL_ITEM_UNKNOWN');
    expect(JSON.stringify(unknown)).toContain(key);
    expect(approved, JSON.stringify(approved)).toMatchObject({ attached: true, feedbackKey: key });
    expect(await feedbackCount()).toBe(before);
    const notes = await rows<{ audience: string; body: string }>(sql`
      SELECT m.audience, m.body FROM feedback_messages m JOIN feedback f ON f.id = m.feedback_id
       WHERE f.project_id = ${w.projectId}::uuid AND f.fb_seq = ${Number(key.slice(3))}`);
    expect(notes).toEqual([
      { audience: 'internal', body: expect.stringContaining('ok cho lên production luôn') },
    ]);
    expect(notes[0]?.body).toContain(go.id);
    // new work the owner asks for beside it is recorded once the session says it is separate
    let separate: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.alice, 'and also add a PDF export', asked.id),
      async (_t, act, message) => {
        separate = await act({
          action: 'record',
          thread: message().thread,
          kind: 'feature',
          title: 'PDF export of refunds',
          summary: 'The owner also wants a PDF export.',
          separate: true,
        });
      },
    );
    expect(separate, JSON.stringify(separate)).toMatchObject({ pending: true });
    expect(w.threadLines(chat.rid, asked.id)).toEqual([]);
    await w.settleWarm();
  });
});
