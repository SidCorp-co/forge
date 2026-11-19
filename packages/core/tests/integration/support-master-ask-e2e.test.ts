/**
 * @direct-test-of packages/core/src/support/master-ask.ts
 * @direct-test-of packages/core/src/support/master-ask-routes.ts
 * @direct-test-of packages/core/src/support/shared-picture.ts
 * @direct-test-of packages/core/src/db/schema-support-asks.ts
 * @direct-test-of packages/core/src/support/turn-retry.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api } from '../helpers/api.js';
import { createTestFeedback, createTestIssue, rows } from '../helpers/factories.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

// ISS-1243 (owner, 2026-11-15). Item 14: a room agent asks its master in its turn, and the answer
// comes back into the same session, which answers the person itself; nothing is relayed and nothing
// is posted beside it. Item 21: the ask wakes the master at once (an outbox event the master wake
// consumes) and its wait is recorded, a breach shown past the bound. Item 20: the agent reads what
// the masters hold for its thread and asker; the master reads the agent's open threads.

const w = new SupportWorld();
let slug = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  slug = String(
    (
      await rows<{ slug: string }>(sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`)
    )[0]?.slug,
  );
}, 120_000);

afterAll(() => w.stop());

type Out = Record<string, unknown>;
type Body = Record<string, unknown>;

/** `alice` writes `text`; the session runs `ask` on it once, and keeps every forge note it is handed. */
async function sessionDoes(
  text: string,
  ask: (thread: string) => Out,
  thread?: string,
): Promise<{ thread: string; out: Out; notes: { thread: string; text: string }[] }> {
  await w.settleWarm();
  let out: Out | null = null;
  const notes: { thread: string; text: string }[] = [];
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge') {
        notes.push({ thread: m.thread, text: m.text });
        continue;
      }
      if (typeof m.from === 'string' || out || !m.text.includes(text)) continue;
      out = await act(ask(m.thread));
    }
  };
  const said = await w.chat.say(w.chat.alice, text, thread);
  await expect.poll(() => out, { timeout: 15_000 }).not.toBeNull();
  return { thread: thread ?? said, out: out as unknown as Out, notes };
}

const asksOf = async (state?: 'all') =>
  api(
    w.owner,
    'GET',
    `/api/projects/${w.projectId}/support/master-asks${state ? `?state=${state}` : ''}`,
  );

describe('ISS-1243: a room agent asks its master in its turn', () => {
  it('records the ask, wakes the master, measures the wait, and hands the answer back into the same thread', async () => {
    const question = 'Is the size-M large print rule for MangoTee live on production?';
    const { thread, out, notes } = await sessionDoes('Size M in to đã xong chưa?', (t) => ({
      action: 'ask_master',
      thread: t,
      question,
    }));
    expect(out, JSON.stringify(out)).toMatchObject({ asked: true, project: slug });
    const askId = String(out.ask);

    // the ask wakes the master: its event is on the outbox for the master wake to consume
    const events = await rows<{ payload: Body }>(
      sql`SELECT payload FROM pipeline_outbox WHERE type = 'support.masterAsked'
           AND payload->>'askId' = ${askId}`,
    );
    expect(events.map((e) => e.payload)).toEqual([
      { askId, projectId: w.projectId, roomId: expect.any(String), thread },
    ]);

    // the master reads it waiting, within the bound
    const open = await asksOf();
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body).toMatchObject({ boundMinutes: 10, waiting: 1, breached: 0 });
    expect((open.body as { asks: Body[] }).asks).toEqual([
      expect.objectContaining({ id: askId, thread, question, answer: null, breached: false }),
    ]);

    // and the agent's open thread, a person waiting on it and the ask open there
    const threads = await api(w.owner, 'GET', `/api/projects/${w.projectId}/support/agent-threads`);
    expect(threads.status).toBe(200);
    expect((threads.body as { threads: Body[] }).threads).toContainEqual(
      expect.objectContaining({ thread, asker: 'alice', awaitingReply: true, openAsks: 1 }),
    );

    // past the bound it reads as a breach, on the ask and in the count
    await db.execute(
      sql`UPDATE support_master_asks SET asked_at = now() - interval '11 minutes' WHERE id = ${askId}::uuid`,
    );
    const late = await asksOf();
    expect(late.body).toMatchObject({ waiting: 1, breached: 1 });

    // the master answers: the answer is handed into the same thread for the session, and nothing posted
    const answer = 'Not yet: ISS-12 is being built and lands today.';
    const answered = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/master-asks/${askId}/answer`,
      { answer },
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({ id: askId, answer, breached: true });
    expect(Number((answered.body as Body).waitedMs)).toBeGreaterThan(10 * 60_000);
    await expect
      .poll(() => notes.some((n) => n.thread === thread && n.text.includes(answer)), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await w.linesIn(thread)).toEqual([]);
    expect((await asksOf()).body).toMatchObject({ waiting: 0, breached: 0 });
    expect((await asksOf('all')).body).toMatchObject({ waiting: 0, breached: 1 });

    // answered once: a second answer, an unknown ask and a stranger are each refused by name
    const again = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/master-asks/${askId}/answer`,
      { answer: 'Again' },
    );
    expect(again.status).toBe(409);
    expect(refusalCodes(again.body as Out)).toEqual(['SUPPORT_MASTER_ASK_ANSWERED']);
    const unknown = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/master-asks/${randomUUID()}/answer`,
      { answer },
    );
    expect(unknown.status).toBe(404);
    expect(refusalCodes(unknown.body as Out)).toEqual(['SUPPORT_MASTER_ASK_UNKNOWN']);
    const stranger = await api(
      w.stranger,
      'POST',
      `/api/projects/${w.projectId}/support/master-asks/${askId}/answer`,
      { answer },
    );
    expect(stranger.status).toBe(403);
  });

  // ISS-1301 (FB-723, Forge-Communicate 2026-11-18 03:33-03:35Z): a turn that took a master's
  // answer and posted nothing left it unanswered, and it was handed again twice more, the same
  // answer each time saying answer the person now
  it("hands a master's answer to the session once, though the turn that took it posts nothing, and still hands a person's message again", async () => {
    const { thread, out } = await sessionDoes('Release 0.26.0 lên đi nhé', (t) => ({
      action: 'ask_master',
      thread: t,
      question: 'The release decider approves 0.26.0: record it and deploy?',
    }));
    const askId = String(out.ask);
    await w.settleWarm();
    // each turn from here completes and says nothing for what it was handed
    w.box.idleTurnsAct = false;
    const handed: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) {
        if (m.thread !== thread) continue;
        handed.push(m.from === 'forge' ? 'answer' : String(m.message));
      }
    };
    try {
      const answered = await api(
        w.owner,
        'POST',
        `/api/projects/${w.projectId}/support/master-asks/${askId}/answer`,
        { answer: 'Recorded; 0.26.0 deploys to production now.' },
      );
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      await expect.poll(() => handed.length, { timeout: 15_000 }).toBe(1);
      await w.settleWarm();
      // past the first retry's 5 s back-off: [ANSWER_HANDED_AGAIN] before the fix
      await new Promise((r) => setTimeout(r, 7_000));
      await w.settleWarm();
      expect(handed).toEqual(['answer']);
      const retried = await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM support_actions
         WHERE thread = ${thread} AND tool IN ('turn_retry', 'turn_unanswered')`);
      expect(retried[0]?.n).toBe(0);

      // a person's message the next turn leaves unanswered still waits again (ISS-977, ISS-1007)
      const id = await w.chat.say(w.chat.alice, 'Bao giờ lên production?', thread);
      await expect.poll(() => handed.length, { timeout: 60_000, interval: 200 }).toBe(4);
      await expect
        .poll(
          async () =>
            (
              await rows(sql`SELECT 1 FROM support_actions
                WHERE thread = ${thread} AND tool = 'turn_unanswered'`)
            ).length,
          { timeout: 15_000 },
        )
        .toBe(1);
      await w.settleWarm();
      expect(handed).toEqual(['answer', id, id, id]);
    } finally {
      w.box.idleTurnsAct = true;
    }
  }, 120_000);

  it('refuses, by name, an ask of a project the room does not follow', async () => {
    const { thread, out } = await sessionDoes('Hỏi giúp bên kho', (t) => ({
      action: 'ask_master',
      thread: t,
      question: 'Where is the stock sync?',
      project: 'no-such-project',
    }));
    expect(refusalCodes(out), JSON.stringify(out)).toEqual(['OPS_OUT_OF_SCOPE']);
    expect(await rows(sql`SELECT 1 FROM support_master_asks WHERE thread = ${thread}`)).toEqual([]);
  });

  it('reads what the masters hold for the thread and its asker: items, issues, step, ETA, landing, asks', async () => {
    // a thread of alice's with an item filed from it, carried by one issue in build and one landed
    const first = await sessionDoes('Đơn RIV-1 lỗi in', (t) => ({ action: 'thread', thread: t }));
    const thread = first.thread;
    const [room] = await rows<{ id: string }>(
      sql`SELECT room_id AS id FROM support_actions WHERE thread = ${thread} LIMIT 1`,
    );
    const building = await createTestIssue(w.projectId, w.ownerId, 9101, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const landed = await createTestIssue(w.projectId, w.ownerId, 9102, {
      status: 'open',
      createdAt: new Date(),
    });
    await db.execute(
      sql`INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${building.id}::uuid, 'build', now())`,
    );
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'awaiting_release', merged_at = now(),
              merged_commit_sha = ${'a'.repeat(40)}, merged_target = 'dev' WHERE id = ${landed.id}::uuid`,
      ),
    );
    await createTestFeedback(w.projectId, w.ownerId, 9101, [building.id, landed.id]);
    await db.execute(sql`
      INSERT INTO support_feedback_links (feedback_id, room_id, project_id, thread, last_phase)
      SELECT id, ${room?.id}::uuid, ${w.projectId}::uuid, ${thread}, 'triaged'
        FROM feedback WHERE project_id = ${w.projectId}::uuid AND fb_seq = 9101`);

    const { out } = await sessionDoes(
      'Vậy khi nào xong?',
      (t) => ({ action: 'in_flight', thread: t }),
      thread,
    );
    expect(out, JSON.stringify(out)).toMatchObject({
      thread,
      asker: { key: w.chat.alice.userId, label: 'alice' },
      promises: [],
      asks: [],
    });
    const [item] = out.items as Body[];
    expect(item).toMatchObject({ thread, feedback: 'FB-9101', project: slug, phase: 'triaged' });
    const issues = item?.issues as Body[];
    expect(issues).toEqual([
      expect.objectContaining({
        key: 'ISS-9101',
        status: 'in_progress',
        step: 'build',
        landed: null,
        eta: expect.objectContaining({ says: expect.any(String) }),
      }),
      expect.objectContaining({
        key: 'ISS-9102',
        status: 'awaiting_release',
        landed: expect.objectContaining({ commit: 'a'.repeat(40), target: 'dev' }),
      }),
    ]);
    // an ETA is never a date the forecast does not hold
    const eta = issues[0]?.eta as Body;
    // the forecast was read (the composition root hands it in), and an ETA is never a date it does not hold
    expect(eta.says).not.toBe('no forecast was read for it');
    if (eta.likelyBy === null) expect(String(eta.says)).toMatch(/^no date: /);
    expect(await w.linesIn(thread)).toEqual([]);
  });
});
