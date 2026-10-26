import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import { type BotLine, SupportWorld } from '../helpers/support-world.js';

// REQ-75 BC-14 under REQ-30 BC-4 (confirm before recording): the session never files Feedback from
// a thread on its own. It restates the route, the title and the thread's link, and the item is filed
// only when the asker confirms by code in the thread; another member's confirm, a cancel and an
// expiry file nothing. The world is support-room-e2e's.

const w = new SupportWorld();
let roomId = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

afterAll(() => w.stop());

const filings = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
    )
  )[0]?.n;

/** The session offers to record the member's message; answers the code it was handed. */
async function offered(text: string): Promise<{ id: string; code: string; prompt: BotLine }> {
  // the last step's turn (a cancel's note to the session) has ended: this message starts its own
  await w.settleWarm();
  let code = '';
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      const out = await act({
        action: 'record',
        thread: m.thread,
        kind: 'defect',
        title: `Fix: ${m.text}`,
        summary: `${m.text} — seen by the member in the group.`,
      });
      expect(out, JSON.stringify(out)).toMatchObject({ pending: true });
      code = String(out.code);
    }
  };
  const id = await w.chat.say(w.chat.alice, text);
  const lines = await w.untilLines((ls) =>
    ls.some((l) => l.tmid === id && l.text.includes('I would record')),
  );
  // the line is posted before the tool answers the session
  await expect.poll(() => code, { timeout: 5_000 }).not.toBe('');
  return { id, code, prompt: lines.find((l) => l.tmid === id) as BotLine };
}

describe('REQ-75: a filing waits for its asker (BC-14, REQ-30 BC-4)', () => {
  it('restates the route, the title and the thread, and files nothing on another member’s confirm or a cancel', async () => {
    const before = await filings();
    const { id, code, prompt } = await offered('The invoice PDF is blank');
    expect(prompt.text).toContain('as Feedback (defect)');
    expect(prompt.text).toContain('"Fix: The invoice PDF is blank"');
    expect(prompt.text).toContain(id);
    expect(prompt.attachments[0]?.actions?.map((a) => a.msg)).toEqual([
      `confirm ${code}`,
      `cancel ${code}`,
    ]);
    expect(await filings()).toBe(before);
    // a filing waits as what it is, never as a fix under a reserved tool name
    expect(
      await rows<{ kind: string; tool: string | null }>(
        sql`SELECT kind, tool FROM support_proposals WHERE room_id = ${roomId}::uuid AND code = ${code}`,
      ),
    ).toEqual([{ kind: 'filing', tool: null }]);

    await w.chat.say(w.chat.bob, `confirm ${code}`, id);
    await w.untilLines((ls) =>
      ls.some((l) => l.text === 'Only @alice can confirm this change. Nothing was recorded.'),
    );
    await w.chat.say(w.chat.alice, `cancel ${code}`, id);
    await w.untilLines((ls) =>
      ls.some((l) => l.text === `Cancelled ${code}. Nothing was recorded.`),
    );
    expect(await filings()).toBe(before);
  });

  it('files nothing once the offer expires, and a late confirm finds nothing waiting', async () => {
    const before = await filings();
    const { id, code } = await offered('Search returns nothing for SKU 0042');
    await db.execute(sql`UPDATE support_proposals SET created_at = now() - interval '1 hour',
      expires_at = now() - interval '1 minute' WHERE room_id = ${roomId}::uuid AND code = ${code}`);
    const { expireSupportFixes } = await import('../../src/support/index.js');
    await expireSupportFixes();
    await w.untilLines((ls) =>
      ls.some(
        (l) =>
          l.text === `The change ${code} expired before it was confirmed. Nothing was recorded.`,
      ),
    );
    await w.chat.say(w.chat.alice, `confirm ${code}`, id);
    await w.untilLines((ls) =>
      ls.some((l) => l.text === `No change is waiting under ${code}. Nothing was done.`),
    );
    expect(await filings()).toBe(before);
  });

  it('files it on the asker’s confirm, as the asker’s report, and tells the session its key', async () => {
    const before = await filings();
    const { id, code } = await offered('Prices round down to the euro');
    const notes = () =>
      w.box.turns.flatMap((t) => t.messages.filter((m) => m.from === 'forge').map((m) => m.text));
    await w.chat.say(w.chat.alice, `confirm ${code}`, id);
    const lines = await w.untilLines((ls) =>
      ls.some((l) => l.tmid === id && l.text.startsWith('Recorded as FB-')),
    );
    expect(await filings()).toBe((before ?? 0) + 1);
    const fb = await w.lastGroupFiling();
    expect(fb.kind).toBe('bug');
    expect(fb.body).toContain('Rocket.Chat support group by alice');
    const key = `FB-${fb.fb_seq}`;
    expect(lines.find((l) => l.tmid === id && l.text.startsWith('Recorded as'))?.text).toContain(
      key,
    );
    await expect
      .poll(() => notes().some((n) => n.includes(`was recorded as ${key}`)), { timeout: 10_000 })
      .toBe(true);
  });
});
