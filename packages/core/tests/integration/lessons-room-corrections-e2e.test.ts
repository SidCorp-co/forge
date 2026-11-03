import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import type { Member, StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/support/thread.ts
// @direct-test-of packages/core/src/support/ops-asker.ts
// @direct-test-of packages/core/src/assistant/turn-lessons.ts
// @direct-test-of packages/core/src/lessons/consumers.ts
// @direct-test-of packages/core/src/lessons/corrections.ts
// @direct-test-of packages/core/src/lessons/corrections-read.ts
// @direct-test-of packages/core/src/lessons/routes.ts
// @direct-test-of packages/core/src/lessons/ports.ts
// @direct-test-of packages/core/src/support/room-replies.ts
// @direct-test-of packages/core/src/steward-ports.ts
// @direct-test-of packages/core/tests/helpers/support-chat-server.ts
//
// REQ-50 r3 BC-1 under ISS-867: a member's message in a bound room's thread that follows the bot's
// answer is read for a correction through the same classifier and threshold as a chat reply, and
// kept as source `room` on the thread's conversation, said by the Forge user the writer resolves to
// or by no user where they resolve to none. A message for others, one below the threshold, one the
// fast model could not read, and a redelivered frame keep nothing more. The world is support-room's.

const classify = vi.hoisted(() => ({
  answer: {
    correction: true,
    confidence: 0.9,
    what: 'It sent the member to Products when the export is under Reports.',
  } as { correction: boolean; confidence: number; what: string } | null,
  calls: 0,
  prompts: [] as string[],
}));

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/llm/index.js')>();
  return {
    ...real,
    callFastModelObject: async (scope: { surface: string }, prompt: string, ...rest: unknown[]) => {
      if (scope.surface !== 'lessons') {
        return (real.callFastModelObject as (...a: unknown[]) => unknown)(scope, prompt, ...rest);
      }
      classify.calls += 1;
      classify.prompts.push(prompt);
      return classify.answer
        ? { ok: true, value: classify.answer, modelId: 'test-fast' }
        : { ok: false, miss: 'unreachable', detail: 'the gateway did not answer' };
    },
  };
});

const ANSWER = 'Open Products, choose Export, then pick CSV.';
const w = new SupportWorld();
let chat: StandInRocketChat;

type Kept = {
  source_ref: string;
  item_kind: string;
  item_id: string;
  item_key: string;
  reason: string;
  by_user_id: string | null;
  agency: string;
  score: number | null;
};
const kept = () =>
  rows<Kept>(sql`
    SELECT source_ref, item_kind, item_id, item_key, reason, by_user_id, agency, score
      FROM corrections WHERE project_id = ${w.projectId}::uuid AND source = 'room'
     ORDER BY said_at`);

/** The conversation message a room message was stored as, once inbound has taken it. */
async function stored(externalId: string): Promise<{ id: string; conversation_id: string }> {
  let row: { id: string; conversation_id: string } | undefined;
  await expect
    .poll(
      async () => {
        [row] = await rows<{ id: string; conversation_id: string }>(
          sql`SELECT id, conversation_id FROM conversation_messages WHERE external_id = ${externalId}`,
        );
        return row !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return row as { id: string; conversation_id: string };
}

/** `who` asks `text` in a new thread, and the session answers it there; the thread's id. */
async function answered(who: Member, text: string): Promise<string> {
  await w.settleWarm();
  w.box.model = async (turn, act) => {
    const m = turn.messages.find((x) => x.from !== 'forge' && x.text === text);
    if (m) await act({ action: 'reply', thread: m.thread, text: ANSWER });
  };
  const thread = await chat.say(who, text);
  await w.untilLines((lines) => lines.some((l) => l.tmid === thread && l.text === ANSWER));
  w.box.model = async () => {};
  return thread;
}

/** `who` says `text` in `thread`, stored and its outbox drained: its chat id and stored row. */
async function says(who: Member, text: string, thread?: string) {
  await w.settleWarm();
  const id = await chat.say(who, text, thread);
  const message = await stored(id);
  await settleOutbox();
  return { externalId: id, ...message };
}

beforeAll(async () => {
  await w.start();
  await w.bind();
  chat = w.chat as StandInRocketChat;
  const [owner] = await rows<{ email: string }>(
    sql`SELECT email FROM users WHERE id = ${w.ownerId}::uuid`,
  );
  // the chat server holds alice's verified address as the owner's: alice is the owner's account;
  // bob is a chat-only identity no Forge account holds
  chat.emails.set(chat.alice.userId, String(owner?.email));
}, 120_000);

afterAll(() => w.stop());

beforeEach(() => {
  classify.answer = {
    correction: true,
    confidence: 0.9,
    what: 'It sent the member to Products when the export is under Reports.',
  };
  classify.calls = 0;
  classify.prompts = [];
});

describe('a room reply to the bot is a correction, as a chat reply is (REQ-50 BC-1, ISS-867)', () => {
  it('keeps a reply the classifier reads as one, on the thread conversation, said by the Forge user', async () => {
    const thread = await answered(chat.alice, 'How do I export the catalog?');
    const before = (await kept()).length;
    const reply = await says(chat.alice, 'No, the export is under Reports now.', thread);
    const all = await kept();
    expect(all.at(-1), 'the room correction kept for the reply').toEqual({
      source_ref: reply.id,
      item_kind: 'conversation',
      item_id: reply.conversation_id,
      item_key: `Room ${chat.rid}`,
      reason: 'It sent the member to Products when the export is under Reports.',
      by_user_id: w.ownerId,
      agency: 'human',
      score: expect.closeTo(0.9, 5),
    });
    expect(all).toHaveLength(before + 1);
    // read once, the bot's answer and the reply side by side
    expect(classify.calls).toBe(1);
    expect(classify.prompts[0]).toContain(ANSWER);
    expect(classify.prompts[0]).toContain('No, the export is under Reports now.');
  }, 60_000);

  it('holds a room correction with its score, and refuses one without, by the table’s checks', async () => {
    const { db } = await import('../../src/db/client.js');
    const { recordCorrection } = await import('../../src/lessons/index.js');
    const input = {
      projectId: w.projectId,
      source: 'room' as const,
      item: {
        kind: 'conversation' as const,
        id: randomUUID(),
        key: `Room ${chat.rid}`,
      },
      reason: 'It named the wrong page.',
      by: { userId: null, agency: 'human' as const },
    };
    const id = await db.transaction((tx) =>
      recordCorrection(tx, { ...input, sourceRef: `held-${chat.rid}`, score: 0.8 }),
    );
    expect(id, 'a room correction is held').not.toBeNull();
    // a room correction is the classifier's reading, so it carries the score a chat one does
    await expect(
      db.transaction((tx) => recordCorrection(tx, { ...input, sourceRef: `unscored-${chat.rid}` })),
    ).rejects.toMatchObject({ cause: { constraint_name: 'corrections_score_chk' } });
  });

  it('keeps a chat-only writer’s correction with no Forge user, never dropping it', async () => {
    const thread = await answered(chat.bob, 'Where is the CSV export?');
    const reply = await says(chat.bob, 'That is wrong, Products has no Export button.', thread);
    expect(classify.calls).toBe(1);
    const row = (await kept()).find((k) => k.source_ref === reply.id);
    expect(row).toMatchObject({ by_user_id: null, agency: 'human', item_key: `Room ${chat.rid}` });
    // who said it stays on the message the correction names
    const [said] = await rows<{ author_key: string; author_label: string }>(
      sql`SELECT author_key, author_label FROM conversation_messages WHERE id = ${reply.id}::uuid`,
    );
    expect(said).toEqual({ author_key: chat.bob.userId, author_label: chat.bob.username });
  }, 60_000);

  it('reads the scrubbed text only: a posted secret never reaches the classifier', async () => {
    const thread = await answered(chat.bob, 'Can you check my token?');
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    await says(chat.bob, `No, you used the wrong one, mine is ${token}`, thread);
    expect(classify.calls).toBe(1);
    expect(classify.prompts[0]).not.toContain(token);
  }, 60_000);

  it('keeps nothing for a message addressed to others, below the threshold, or on a gateway miss', async () => {
    const before = (await kept()).length;
    const t1 = await answered(chat.bob, 'Is the import running?');
    await says(chat.bob, '@alice can you check the import?', t1);
    // a message for others is not read at all
    expect(classify.calls).toBe(0);

    const t2 = await answered(chat.bob, 'Is the report done?');
    classify.answer = { correction: true, confidence: 0.5, what: 'Maybe the tone.' };
    await says(chat.bob, 'Hmm, ok.', t2);
    expect(classify.calls).toBe(1);

    const t3 = await answered(chat.bob, 'Did the sync finish?');
    classify.answer = null;
    await says(chat.bob, 'No, it stopped at noon.', t3);
    expect(classify.calls).toBe(2);
    expect(await kept()).toHaveLength(before);
  }, 90_000);

  it('reads no message that follows no answer of the bot', async () => {
    // a thread's opening message follows nothing the bot said
    await says(chat.bob, 'The labels print blank.');
    expect(classify.calls).toBe(0);
  }, 60_000);

  it('keeps one row when the stream carries the reply again', async () => {
    const thread = await answered(chat.alice, 'How do I reset a price?');
    const text = 'No, prices reset from the Pricing page.';
    const reply = await says(chat.alice, text, thread);
    expect(classify.calls).toBe(1);
    // core restarts its chat connection, which forgets the frames it took, and the stream replays one
    const { startRocketChatManager, stopRocketChatManager } = await import(
      '../../src/integrations/rocketchat/index.js'
    );
    await stopRocketChatManager();
    await startRocketChatManager();
    await chat.resend(reply.externalId, chat.alice, text, thread);
    // a later frame on the same stream is stored once the replayed one was taken
    await says(chat.bob, 'Thanks, all good.');
    const ofReply = (await kept()).filter((k) => k.source_ref === reply.id);
    expect(ofReply).toHaveLength(1);
    expect(classify.calls).toBe(1);
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM conversation_messages WHERE external_id = ${reply.externalId}`,
    );
    expect(count?.n).toBe(1);
  }, 60_000);

  // forge-core-61 (2026-11-03): no route read a correction, so a kept room correction could be
  // witnessed only in the database; an agent now reads the window's corrections over REST
  it('answers the kept room correction to a reader of the project, and refuses a window that is not one', async () => {
    const thread = await answered(chat.bob, 'Which page holds the stock report?');
    const reply = await says(chat.bob, 'No, stock is under Inventory, not Reports.', thread);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const path = `/api/projects/${w.projectId}/lessons/corrections`;
    const got = await api(
      w.owner,
      'GET',
      `${path}?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&source=room`,
    );
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const listed = got.body.corrections as Array<Record<string, unknown>>;
    expect(listed.every((c) => c.source === 'room')).toBe(true);
    const ids = (await kept()).filter((k) => k.source_ref === reply.id);
    expect(ids).toHaveLength(1);
    expect(listed[0], 'the newest room correction is the reply just kept').toMatchObject({
      source: 'room',
      item: { kind: 'conversation', key: `Room ${chat.rid}` },
      reason: 'It sent the member to Products when the export is under Reports.',
      byUserId: null,
      agency: 'human',
      score: expect.closeTo(0.9, 5),
      lesson: null,
      rejected: false,
    });
    expect(got.body.truncated).toBe(false);
    const backwards = await api(
      w.owner,
      'GET',
      `${path}?since=${encodeURIComponent(until)}&until=${encodeURIComponent(since)}`,
    );
    expect(backwards.status, 'a backwards window is the caller’s to fix').toBeGreaterThanOrEqual(
      400,
    );
    expect(backwards.status).toBeLessThan(500);
    expect(JSON.stringify(backwards.body)).toContain('LESSON_WINDOW_INVALID');
    // the reply is the session's next turn: the world stops only once the box has taken it, or the
    // stop races it and the turn is told to no box (NO_CLAUDE_CLIENT at teardown)
    await w.settleWarm();
  }, 60_000);
});
