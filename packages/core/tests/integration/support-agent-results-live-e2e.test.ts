import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { deliverWaiting } from '../../src/support/dispatch.js';
import { tellProjectResults } from '../../src/support/result.js';
import { readThread } from '../../src/support/service.js';
import { insertAction, roomById, threadConversation } from '../../src/support/store.js';
import { createTestFeedback, createTestIssue, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { TurnMessage } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/store.ts
// @direct-test-of packages/core/src/support/result.ts
// @direct-test-of packages/core/src/support/promise-watch.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/live-claims.ts
// @direct-test-of packages/core/src/support/service.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/prompt.ts
//
// ISS-1117: a result note core hands a channel agent opens one post in its thread, counted from when
// it was handed, and the notes one thread holds together are handed as one turn. ISS-1123: a post
// saying what is or is not live stands only on a release read of the same turn, the session's own or
// a note core handed it in that turn; without one it is refused by name and nothing is posted.

const ASKED_LIVE = 'AdminHub 0.17.0 đã lên production chưa?'; // i18n-allow: the asker's question, as written
const NOT_LIVE = '0.17.0 chưa lên production'; // i18n-allow: the claim posted from memory on 2026-11-07
const ASKED_AGAIN = 'kiểm tra lại giúp mình?'; // i18n-allow: the asker's follow-up, as written
const ASKED_ORDER = 'Đơn 4321 sao rồi?'; // i18n-allow: the asker's question, as written
const ORDER_STATE = 'Đơn 4321 đang vận chuyển, chưa có mã vận đơn.'; // i18n-allow: an order's state, no release claim

const w = new AgentWorld();
let chat: StandInRocketChat;
let roomId = '';
let slug = '';

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [room] = await rows<{ id: string }>(sql`
    SELECT id FROM support_rooms WHERE project_id = ${w.projectId}::uuid AND rid = ${chat.rid}`);
  roomId = String(room?.id);
  const [project] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  slug = String(project?.slug);
}, 120_000);

afterAll(() => w.stop());

/** A result note as `result.ts` records it, in `thread`; handed on only where `hand` says. */
async function note(thread: string, fb: string, hand = false): Promise<void> {
  await insertAction({
    roomId,
    projectId: w.projectId,
    conversationId: await threadConversation(roomId, thread),
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: `${fb}, recorded from this thread, is live now. Post its result in this thread.`,
    },
    externalId: `result:${fb}`,
  });
  if (hand) await deliverWaiting(roomId);
}

describe('ISS-1117: a result note opens one post in its thread', () => {
  it('posts FB-7’s result, then the result of FB-8..11 recorded meanwhile and handed after it, once', async () => {
    const asked = await w.hear(
      () => chat.say(chat.bob, 'do the carrier links work on the shop?'),
      async (_t, act, m) => {
        const out = await act({
          action: 'reply',
          thread: m().thread,
          text: 'The carrier links are recorded for the team.',
        });
        expect(out.isError, JSON.stringify(out)).toBe(false);
      },
    );
    const thread = asked.id;
    await w.settleWarm();
    const outs: Record<string, unknown>[] = [];
    const handed: string[][] = [];
    w.box.model = async (turn, act) => {
      const notes = turn.messages.filter((m) => m.from === 'forge' && m.thread === thread);
      if (notes.length === 0) return;
      handed.push(notes.map((n) => n.text));
      if (handed.length === 1) {
        // FB-8..11 go live while the session writes FB-7's result: recorded now, handed next turn
        for (const fb of ['FB-8', 'FB-9', 'FB-10', 'FB-11']) await note(thread, fb);
        outs.push(
          await act({
            action: 'reply',
            thread,
            text: 'The first carrier link is ready on the shop.',
          }),
        );
        return;
      }
      // its earlier post is corrected by the notes, and the core notes are this turn's release read
      outs.push(
        await act({
          action: 'reply',
          thread,
          text: 'Correction: the carrier links are live on production now.',
        }),
      );
      outs.push(await act({ action: 'reply', thread, text: 'Still checking the rest.' }));
    };
    await note(thread, 'FB-7', true);
    await expect.poll(() => outs.length, { timeout: 20_000 }).toBe(3);
    await w.settleWarm();
    expect(outs[0]?.isError, JSON.stringify(outs[0])).toBe(false);
    // the planted red: before ISS-1117 this was SUPPORT_ONE_RESULT_PER_REQUEST
    expect(outs[1]?.isError, JSON.stringify(outs[1])).toBe(false);
    // an acknowledgement or progress is still refused
    expect(code(outs[2])).toBe('SUPPORT_ONE_RESULT_PER_REQUEST');
    // FB-8..11 went to the session together, in the turn after FB-7's
    expect(handed.map((h) => h.length)).toEqual([1, 4]);
    expect(w.threadLines(chat.rid, thread).map((l) => l.text)).toEqual([
      'The carrier links are recorded for the team.',
      'The first carrier link is ready on the shop.',
      'Correction: the carrier links are live on production now.',
    ]);
    // and the correction is on the thread's conversation, as every post is
    const room = await roomById(roomId);
    const read = room ? await readThread(room, thread) : null;
    const said = read?.ok ? read.value.map((l) => l.text) : [];
    expect(said).toContain('Correction: the carrier links are live on production now.');
  });

  it('hands the result notes one pass records for a thread to the session as one turn', async () => {
    const asked = await w.hear(
      () => chat.say(chat.bob, 'are the invoice exports fixed?'),
      async (_t, act, m) => {
        await act({ action: 'reply', thread: m().thread, text: 'Recorded for the team.' });
      },
    );
    const thread = asked.id;
    await w.settleWarm();
    // three items recorded from the thread, each routed to an issue that has now landed
    for (const seq of [21, 22, 23]) {
      const issue = await createTestIssue(w.projectId, w.ownerId, 8000 + seq, {
        status: 'open',
        createdAt: new Date(),
      });
      await createTestFeedback(w.projectId, w.ownerId, seq, [issue.id]);
      await withKernelMarker(db, (tx) =>
        tx.execute(
          sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${issue.id}::uuid`,
        ),
      );
      await db.execute(sql`
        INSERT INTO support_feedback_links (feedback_id, room_id, project_id, thread, last_phase)
        SELECT id, ${roomId}::uuid, ${w.projectId}::uuid, ${thread}, 'triaged'
          FROM feedback WHERE project_id = ${w.projectId}::uuid AND fb_seq = ${seq}`);
    }
    const turns: TurnMessage[][] = [];
    let out: Record<string, unknown> = {};
    w.box.model = async (turn, act) => {
      const notes = turn.messages.filter((m) => m.from === 'forge' && m.thread === thread);
      if (notes.length === 0) return;
      turns.push(notes);
      if (turns.length === 1) {
        out = await act({ action: 'reply', thread, text: 'All three are fixed for you now.' });
      }
    };
    expect(await tellProjectResults(w.projectId)).toBe(3);
    await expect.poll(() => turns.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await w.settleWarm();
    // the planted red: before ISS-1117 the first note started a turn alone and the rest followed it
    expect(turns.map((t) => t.length)).toEqual([3]);
    expect(out.isError, JSON.stringify(out)).toBe(false);
  });
});

describe('ISS-1091: a read-only request comes back with what was found', () => {
  it('hands the session the team’s last note on the carrying issue, scrubbed, with the result', async () => {
    const asked = await w.hear(
      () => chat.say(chat.bob, 'read the ShipResolve config on hub-cnw and tell me'),
      async (_t, act, m) => {
        await act({ action: 'reply', thread: m().thread, text: 'Recorded for the team.' });
      },
    );
    const thread = asked.id;
    await w.settleWarm();
    const found = 'hub-cnw ShipResolve reads retries 3 and a 30 second timeout; hub-lsm the same.';
    const issue = await createTestIssue(w.projectId, w.ownerId, 8091, {
      status: 'open',
      createdAt: new Date(),
    });
    await createTestFeedback(w.projectId, w.ownerId, 91, [issue.id]);
    await db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, created_at)
      VALUES (${issue.id}, ${w.ownerId}, 'Reading the config now.', now() - interval '2 minutes'),
             (${issue.id}, ${w.ownerId}, ${found}, now() - interval '1 minute')`);
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${issue.id}::uuid`,
      ),
    );
    await db.execute(sql`
      INSERT INTO support_feedback_links (feedback_id, room_id, project_id, thread, last_phase)
      SELECT id, ${roomId}::uuid, ${w.projectId}::uuid, ${thread}, 'triaged'
        FROM feedback WHERE project_id = ${w.projectId}::uuid AND fb_seq = 91`);
    const handed: string[] = [];
    w.box.model = async (turn, act) => {
      const notes = turn.messages.filter((m) => m.from === 'forge' && m.thread === thread);
      if (notes.length === 0) return;
      handed.push(...notes.map((n) => n.text));
      await act({ action: 'reply', thread, text: 'The retries are 3 and the timeout 30 seconds.' });
    };
    expect(await tellProjectResults(w.projectId)).toBe(1);
    await expect.poll(() => handed.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await w.settleWarm();
    // the planted red: the note said only that FB-91 was live, with nothing found to post
    expect(handed.join('\n')).toContain(`What the team found or wrote last on it`);
    expect(handed.join('\n')).toContain(found);
    expect(handed.join('\n')).not.toContain('Reading the config now.');
  });
});

describe('ISS-1123: what is live is said from a release read of the same turn', () => {
  it('refuses "0.17.0 chưa lên production" from a turn that read no release, naming the read', async () => {
    let out: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(chat.bob, ASKED_LIVE),
      async (_t, act, m) => {
        out = await act({ action: 'reply', thread: m().thread, text: NOT_LIVE });
      },
    );
    // the planted red: before ISS-1123 this was posted
    expect(code(out)).toBe('SUPPORT_LIVE_CLAIM_UNREAD');
    expect(JSON.stringify(out)).toContain('support.releases { project }');
    expect(w.threadLines(chat.rid, asked.id)).toEqual([]);
    const refused = await rows<{ output: Record<string, unknown> }>(sql`
      SELECT output FROM support_actions
       WHERE room_id = ${roomId}::uuid AND thread = ${asked.id} AND kind = 'refused'`);
    expect(refused.map((r) => r.output.code)).toEqual(['SUPPORT_LIVE_CLAIM_UNREAD']);

    // the next turn reads the releases first, and the same claim stands on that read
    let read: Record<string, unknown> = {};
    let backed: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, ASKED_AGAIN, asked.id),
      async (_t, act) => {
        read = await act({ action: 'releases', project: slug });
        backed = await act({ action: 'reply', thread: asked.id, text: NOT_LIVE });
      },
    );
    expect(read.isError, JSON.stringify(read)).toBe(false);
    expect(backed.isError, JSON.stringify(backed)).toBe(false);
    expect(w.threadLines(chat.rid, asked.id).map((l) => l.text)).toEqual([NOT_LIVE]);
  });

  it('holds a read to its own turn: a read of an earlier turn backs no claim', async () => {
    let read: Record<string, unknown> = {};
    const first = await w.hear(
      () => chat.say(chat.bob, 'what is the newest release?'),
      async (_t, act) => {
        read = await act({ action: 'releases', project: slug });
      },
    );
    expect(read.isError, JSON.stringify(read)).toBe(false);
    let out: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'so is 0.17.0 out?', first.id),
      async (_t, act) => {
        out = await act({ action: 'reply', thread: first.id, text: 'Yes, 0.17.0 is live.' });
      },
    );
    expect(code(out)).toBe('SUPPORT_LIVE_CLAIM_UNREAD');
  });

  it('posts a reply that says nothing of what is live with no read, and is briefed to read first', async () => {
    let out: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, ASKED_ORDER),
      async (_t, act, m) => {
        out = await act({ action: 'reply', thread: m().thread, text: ORDER_STATE });
      },
    );
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(w.brief()).toContain(
      'Whether something is live, deployed or released you say only from a read of the same turn',
    );
  });
});
