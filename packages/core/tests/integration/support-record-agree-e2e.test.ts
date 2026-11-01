import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

// REQ-75 BC-14 under REQ-30 BC-4 (agree before recording), as ISS-845 left it: the session never
// files Feedback from a thread on its own. Core records the offer and posts nothing; the session asks
// in its own words, and the item is filed only when the session cites the asker's agreeing message.
// Another member's answer, the asker's no and an expiry file nothing. The world is support-room-e2e's.

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
  )[0]?.n ?? 0;

/** The session offers to record the member's message; the act's answer and the thread come back. */
async function offered(
  text: string,
): Promise<{ id: string; proposal: string; out: Record<string, unknown> }> {
  await w.settleWarm();
  let out: Record<string, unknown> | null = null;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      out = await act({
        action: 'record',
        thread: m.thread,
        kind: 'defect',
        title: `Fix: ${m.text}`,
        summary: `${m.text} — seen by the member in the group.`,
      });
    }
  };
  const id = await w.chat.say(w.chat.alice, text);
  await expect.poll(() => out, { timeout: 10_000 }).not.toBeNull();
  const got = out as unknown as Record<string, unknown>;
  expect(got, JSON.stringify(got)).toMatchObject({ pending: true });
  return { id, proposal: String(got.proposal), out: got };
}

describe('REQ-75: a filing waits for its asker (BC-14, REQ-30 BC-4)', () => {
  it('hands the session the offer and whom it waits on, posts nothing, and files nothing on another member’s answer or the asker’s no', async () => {
    const before = await filings();
    const { id, proposal, out } = await offered('The invoice PDF is blank');
    expect(out).toMatchObject({
      pending: true,
      proposal: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/),
      waitsOn: '@alice',
      expiresAt: expect.any(String),
    });
    expect(String(out.next)).toContain(`proposal: "${proposal}"`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await w.linesIn(id)).toEqual([]);
    expect(await filings()).toBe(before);
    // a filing waits as what it is, never as a fix under a reserved tool name
    expect(
      await rows<{ kind: string; tool: string | null }>(
        sql`SELECT kind, tool FROM support_proposals WHERE room_id = ${roomId}::uuid AND code = ${proposal}`,
      ),
    ).toEqual([{ kind: 'filing', tool: null }]);

    const bob = await w.agreeBy(w.chat.bob, 'ok, ghi đi', id, proposal);
    expect(refusalCodes(bob.out), JSON.stringify(bob.out)).toEqual(['SUPPORT_NOT_A_CONFIRMER']);
    const no = await w.agreeBy(w.chat.alice, 'thôi, không cần', id, proposal, {
      decision: 'decline',
    });
    expect(no.out, JSON.stringify(no.out)).toMatchObject({ declined: true });
    expect(String(no.out.what)).toContain('Nothing was recorded.');
    // a declined offer waits for nothing more: a later yes finds nothing under its handle
    const late = await w.agreeBy(w.chat.alice, 'à mà thôi ghi đi', id, proposal);
    expect(refusalCodes(late.out), JSON.stringify(late.out)).toEqual(['SUPPORT_PROPOSAL_UNKNOWN']);
    expect(await filings()).toBe(before);
    expect(await w.linesIn(id)).toEqual([]);
  });

  it('files nothing once the offer expires, and a late agreement finds nothing waiting', async () => {
    const before = await filings();
    const { id, proposal } = await offered('Search returns nothing for SKU 0042');
    await db.execute(sql`UPDATE support_proposals SET created_at = now() - interval '1 hour',
      expires_at = now() - interval '1 minute' WHERE room_id = ${roomId}::uuid AND code = ${proposal}`);
    // past its time and not yet swept: the agreement itself finds it expired
    const due = await w.agreeBy(w.chat.alice, 'yes please', id, proposal);
    expect(refusalCodes(due.out), JSON.stringify(due.out)).toEqual(['SUPPORT_PROPOSAL_EXPIRED']);
    expect(
      (
        await rows<{ state: string }>(
          sql`SELECT state FROM support_proposals WHERE room_id = ${roomId}::uuid AND code = ${proposal}`,
        )
      )[0]?.state,
    ).toBe('expired');

    // the sweep expires an unanswered one, recorded and posted nowhere
    const second = await offered('Search returns nothing for SKU 0043');
    await db.execute(sql`UPDATE support_proposals SET created_at = now() - interval '1 hour',
      expires_at = now() - interval '1 minute' WHERE room_id = ${roomId}::uuid AND code = ${second.proposal}`);
    const { expireSupportFixes } = await import('../../src/support/index.js');
    await expireSupportFixes();
    const expired = await rows<{ kind: string }>(sql`
      SELECT a.kind FROM support_actions a JOIN support_proposals p ON p.id = a.proposal_id
       WHERE p.room_id = ${roomId}::uuid AND p.code = ${second.proposal} AND a.kind = 'fix_expired'`);
    expect(expired).toHaveLength(1);
    const late = await w.agreeBy(w.chat.alice, 'ok go', second.id, second.proposal);
    expect(refusalCodes(late.out), JSON.stringify(late.out)).toEqual(['SUPPORT_PROPOSAL_UNKNOWN']);
    expect(await filings()).toBe(before);
    expect([...(await w.linesIn(id)), ...(await w.linesIn(second.id))]).toEqual([]);
  });

  it('files it on the asker’s agreement, as the asker’s report, and hands the session its key', async () => {
    const before = await filings();
    const { id, proposal } = await offered('Prices round down to the euro');
    const { out } = await w.agreeBy(w.chat.alice, 'ừ, ghi lại giúp mình', id, proposal);
    expect(out, JSON.stringify(out)).toMatchObject({
      recorded: true,
      feedbackKey: expect.stringMatching(/^FB-\d+$/),
    });
    expect(await filings()).toBe(before + 1);
    const fb = await w.lastGroupFiling();
    expect(fb.kind).toBe('bug');
    expect(fb.body).toContain('Rocket.Chat support group by alice');
    expect(out.feedbackKey).toBe(`FB-${fb.fb_seq}`);
    expect(String(out.what)).toContain(`was recorded as FB-${fb.fb_seq}`);
    // the agent tells the person in its own words: core posted nothing in the thread
    expect(await w.linesIn(id)).toEqual([]);
  });
});
