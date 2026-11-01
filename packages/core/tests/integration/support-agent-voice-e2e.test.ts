import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// ISS-845 (owner, 2026-11-01): in a channel room the session agent is the only voice. Core posts no
// prompt, code or "Recorded as" line of its own on the conversational paths: the agent asks in its
// own words, the person agrees in theirs, and the agent records by citing that agreeing message.
// Core checks the citation (who wrote it, where, when) and hands the result or the refusal back to
// the agent as tool output, never into the room.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

const filings = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
    )
  )[0]?.n ?? 0;

/** The lines the bot posted in a thread (its opening message's id). */
const linesIn = async (thread: string) =>
  (await w.chat.botLines()).filter((l) => l.tmid === thread || l.id === thread);

type Out = Record<string, unknown>;

/**
 * The member writes `text`; the session offers to record it and answers nothing in the room. Returns
 * the thread and the proposal the session was handed.
 */
async function offered(text: string): Promise<{ thread: string; proposal: string; out: Out }> {
  await w.settleWarm();
  let out: Out | null = null;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      out = await act({
        action: 'record',
        thread: m.thread,
        kind: 'defect',
        title: `Fix: ${m.text}`,
        summary: `${m.text}, seen by the member in the group.`,
      });
    }
  };
  const thread = await w.chat.say(w.chat.alice, text);
  await expect.poll(() => out, { timeout: 10_000 }).not.toBeNull();
  const got = out as unknown as Out;
  expect(got, JSON.stringify(got)).toMatchObject({ pending: true });
  return { thread, proposal: String(got.proposal), out: got };
}

/** `who` writes `text` in `thread`; the session cites it as the agreement to `proposal`. */
async function agreedBy(
  who: typeof w.chat.alice,
  text: string,
  thread: string,
  proposal: string,
  cite?: (id: string) => { message: string; thread?: string },
): Promise<{ id: string; out: Out }> {
  await w.settleWarm();
  let out: Out | null = null;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || !m.message) continue;
      const cited = cite ? cite(m.message) : { message: m.message };
      out = await act({
        action: 'agree',
        thread: cited.thread ?? m.thread,
        proposal,
        message: cited.message,
      });
    }
  };
  const id = await w.chat.say(who, text, thread);
  await expect.poll(() => out, { timeout: 10_000 }).not.toBeNull();
  return { id, out: out as unknown as Out };
}

/** The refusal codes an act answered, as the tool hands them to the session. */
const codesOf = (out: Out) =>
  (
    (out.error as { refusals?: { code: string }[] } | undefined)?.refusals ??
    (out.refusals as { code: string }[] | undefined) ??
    []
  ).map((r) => r.code);

describe('ISS-845: the agent is the only voice in a channel room', () => {
  it('posts no prompt and no confirm code when the agent offers to record', async () => {
    const before = await filings();
    const { thread, out } = await offered('Hóa đơn PDF bị trắng trang');
    // the agent is handed what it needs to ask in its own words, and the room is told nothing
    expect(out).toMatchObject({ pending: true, waitsOn: expect.any(String) });
    await new Promise((r) => setTimeout(r, 300));
    expect(await linesIn(thread)).toEqual([]);
    expect(await filings()).toBe(before);
  });

  it('records on the asker’s plain "ừ", cited by message id, and hands the key back to the agent', async () => {
    const before = await filings();
    const { thread, proposal } = await offered('Giá bị làm tròn xuống');
    const { out } = await agreedBy(w.chat.alice, 'ừ', thread, proposal);
    expect(out, JSON.stringify(out)).toMatchObject({
      recorded: true,
      feedbackKey: expect.stringMatching(/^FB-\d+$/),
    });
    expect(await filings()).toBe(before + 1);
    const fb = await w.lastGroupFiling();
    expect(out.feedbackKey).toBe(`FB-${fb.fb_seq}`);
    expect(fb.body).toContain('Rocket.Chat support group by alice');
    // nothing core-authored reached the thread: the agent tells the person in its own words
    expect(await linesIn(thread)).toEqual([]);
  });

  it('refuses, to the agent and by name, a citation of another member, an earlier message or another thread', async () => {
    const before = await filings();
    const { thread, proposal } = await offered('Tìm kiếm không ra SKU 0042');

    const bob = await agreedBy(w.chat.bob, 'ok', thread, proposal);
    expect(codesOf(bob.out), JSON.stringify(bob.out)).toEqual(['SUPPORT_NOT_A_CONFIRMER']);

    // the asker's own first message, written before the proposal, agrees to nothing
    const early = await agreedBy(w.chat.alice, 'để mình xem', thread, proposal, () => ({
      message: thread,
    }));
    expect(codesOf(early.out), JSON.stringify(early.out)).toEqual([
      'SUPPORT_AGREEMENT_BEFORE_PROPOSAL',
    ]);

    // an "ok" the asker wrote in another thread is no agreement in this one
    const elsewhere = await w.chat.say(w.chat.alice, 'ok');
    await w.settleWarm();
    const other = await agreedBy(w.chat.alice, 'chờ chút', thread, proposal, () => ({
      message: elsewhere,
    }));
    expect(codesOf(other.out), JSON.stringify(other.out)).toEqual([
      'SUPPORT_AGREEMENT_OTHER_THREAD',
    ]);

    expect(await filings()).toBe(before);
    expect(await linesIn(thread)).toEqual([]);

    // the proposal still waits: the asker's real agreement records it
    const yes = await agreedBy(w.chat.alice, 'được, ghi lại giúp mình', thread, proposal);
    expect(yes.out, JSON.stringify(yes.out)).toMatchObject({ recorded: true });
    expect(await filings()).toBe(before + 1);
    expect(await linesIn(thread)).toEqual([]);
  });

  it('takes a typed `confirm <code>` as an ordinary message for the agent, not a command core answers', async () => {
    const { thread, proposal } = await offered('Xuất CSV bị lỗi font');
    await w.settleWarm();
    const handed: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') handed.push(m.text);
    };
    await w.chat.say(w.chat.alice, `confirm ${proposal}`, thread);
    await expect.poll(() => handed, { timeout: 10_000 }).toContain(`confirm ${proposal}`);
    expect(await linesIn(thread)).toEqual([]);
  });
});
