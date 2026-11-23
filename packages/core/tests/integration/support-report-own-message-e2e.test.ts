import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { newQueryTiming, withQueryTiming } from '../../src/db/query-timing.js';
import { issueWorkspaceCredential } from '../../src/devices/workspace-credential.js';
import { readMasterOwedNow } from '../../src/masters/owed-read.js';
import { mastersPorts } from '../../src/masters/ports.js';
import { editBotPost } from '../../src/support/post-edit-door.js';
import { roomById } from '../../src/support/store.js';
import { dropHeldTooLong, HELD_MESSAGE_MAX_AGE_MS } from '../../src/support/turn-retry.js';
import { api } from '../helpers/api.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/post-edit-door.ts
// @direct-test-of packages/core/src/support/report-post.ts
// @direct-test-of packages/core/src/support/dropped-unanswered.ts
// @direct-test-of packages/core/src/support/thread-answer.ts
// @direct-test-of packages/core/src/support/one-voice.ts
// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/masters/owed-read.ts
// @direct-test-of packages/core/src/masters/routes.ts
//
// ISS-1417, agenfold's owner group 2026-11-22: the room agent answered the owner at 09:38, and at
// 10:08 the master's 0.310.0 release-check post took that answer as the thread's one voice and
// rewrote it, so the owner never read it. His 09:47 message, sent as the box's disk failed, got no
// turn and was told nowhere. A report updates only its own earlier post, the edit door refuses any
// other by name, and a dropped owner's message is listed where the master reads what is owed.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;

const ANSWER = 'Em hướng dẫn sai: hiện chưa có chỗ nào trên web để nhập kết nối chat.';
const CHECK = 'Bản 0.310.0 đã kiểm từ phía anh: 0 trên 1 đạt.';
const RECHECK = 'Bản 0.310.0 đã kiểm lại từ phía anh: 1 trên 1 đạt.';
const NEXT = 'Bản 0.311.0 đã kiểm từ phía anh: 1 trên 1 đạt.';

const post = (text: string, thread: string, report?: string) =>
  api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, {
    text,
    rid: chat.rid,
    thread,
    ...(report ? { report } : {}),
  });
const lines = (thread: string) =>
  chat
    .linesIn(chat.rid)
    .filter((l) => l.tmid === thread)
    .map((l) => l.text);

/** The owner asks, and the room agent answers `text` in his thread. */
async function answered(ask: string, text: string): Promise<string> {
  await w.settleWarm();
  let done = false;
  w.box.model = async (turn: Turn, act) => {
    const asked = turn.messages.find((m) => m.from !== 'forge');
    if (done || !asked) return;
    const out = await act({ action: 'reply', thread: asked.thread, text });
    expect(out, JSON.stringify(out)).not.toHaveProperty('error');
    done = true;
  };
  const id = await chat.say(chat.alice, ask);
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return id;
}

async function replyId(thread: string, text: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    SELECT external_id AS id FROM support_actions
     WHERE thread = ${thread} AND kind = 'reply' AND input->>'text' = ${text}`);
  if (!row) throw new Error(`no reply ${text} in ${thread}`);
  return row.id;
}

const roomId = async () => {
  const [room] = await rows<{ id: string }>(
    sql`SELECT id FROM support_rooms WHERE rid = ${chat.rid} AND project_id = ${w.projectId}::uuid`,
  );
  return String(room?.id);
};

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  // the owner's own group, as agenfold's: its agent answers him, and he is the binding's owner
  await w.bindTarget({
    rids: [chat.rid],
    agent: {
      product: 'Agenfold, the agent builder',
      readers: 'users',
      grants: { abilities: ['read_checkout'], owner: chat.alice.userId },
    },
  });
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1417: a release-check report never takes the room agent's answer", () => {
  it("leaves the agent's answer and posts its own, then updates only that post", async () => {
    const thread = await answered('Đâu? Dùng kiểu gì', ANSWER);
    expect(lines(thread)).toEqual([ANSWER]);
    // [REPORT_TOOK_THE_ANSWER] before the fix: the report replaced the agent's answer in place
    const first = await post(CHECK, thread, 'release 0.310.0');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).not.toHaveProperty('replaced');
    expect(lines(thread)).toEqual([ANSWER, CHECK]);
    // checked again: the same report updates its own post, keyed by its record, never the latest bot line
    const again = await post(RECHECK, thread, 'release 0.310.0');
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({ messageId: first.body.messageId, updated: true });
    expect(lines(thread)).toEqual([ANSWER, RECHECK]);
    // another release is another report: a message of its own
    const next = await post(NEXT, thread, 'release 0.311.0');
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body).not.toHaveProperty('updated');
    expect(lines(thread)).toEqual([ANSWER, RECHECK, NEXT]);
  });

  it("refuses by name, inside core, a report's edit of the agent's reply, and the room is unchanged", async () => {
    const thread = await answered('Kết nối chat nhập ở đâu?', ANSWER);
    const messageId = await replyId(thread, ANSWER);
    const room = await roomById(await roomId());
    if (!room) throw new Error('no room');
    const out = await editBotPost({
      room,
      messageId,
      text: CHECK,
      proof: { kind: 'fixed', text: CHECK } as never,
      editor: { kind: 'report', projectId: w.projectId, report: 'release 0.310.0' },
    });
    expect(out.ok).toBe(false);
    const refused = 'refused' in out ? out.refused : null;
    expect(refused && !refused.ok ? refused.refusals[0] : null).toMatchObject({
      code: 'SUPPORT_EDIT_NOT_ITS_OWN',
      detail: expect.stringContaining("the room agent's reply"),
    });
    expect(lines(thread)).toEqual([ANSWER]);
  });
});

/** Every statement text `fn` sent, its own and each named part's. */
async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const t = newQueryTiming();
  await withQueryTiming(t, fn);
  return [...t.sent.keys(), ...[...t.legs.values()].flatMap((l) => [...l.sent.keys()])];
}

const WRITES =
  /\b(insert\s+into|update\s+"?\w+"?\s+set|delete\s+from|truncate|for\s+update|pg_advisory_(?:xact_)?lock)\b/i;

/** What the project's master holds, which a read must leave as it found it: its session and its passes. */
const masterStateOf = () =>
  rows<{ id: string }>(sql`
    SELECT s.id, s.status, s.metadata, s.updated_at,
           (SELECT count(*) FROM master_passes p WHERE p.master_session_id = s.id) AS passes
      FROM agent_sessions s
     WHERE s.project_id = ${w.projectId} AND s.kind = ${MASTER_SESSION_KIND}`);

/**
 * The owed line a judge reads (ISS-1421): `GET masters/owed` on the credential a checkout on the
 * project's box carries, which is what a declared `--role qa` run's pane sends; the read changes
 * nothing its master holds, and the composer under it sends no write statement.
 */
async function owedLineAsAJudge(): Promise<{ owedLine: string }> {
  const agent = await createTestUser({ kind: 'agent' });
  await addProjectMember(w.projectId, agent.id, 'member');
  const judge = await issueWorkspaceCredential({
    deviceId: w.box.deviceId,
    projectId: w.projectId,
    holderUserId: agent.id,
  });
  // the project's master, live on the box the line is composed for
  const master = await api(w.box.token, 'POST', '/api/devices/me/master-session', {
    projectId: w.projectId,
    name: 'forge-master-order-desk',
    maxJobPanes: 1,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  const before = await masterStateOf();
  expect(before).toHaveLength(1);
  const read = await api(judge, 'GET', `/api/projects/${w.projectId}/masters/owed`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(await masterStateOf()).toEqual(before);
  const sent = await statementsOf(() => readMasterOwedNow(w.projectId));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.filter((text) => WRITES.test(text))).toEqual([]);
  const body = read.body as {
    device: { id: string };
    sessionId: string | null;
    work: { owedLine: string };
  };
  expect(body).toMatchObject({ device: { id: w.box.deviceId }, sessionId: before[0]?.id });
  return body.work;
}

describe("ISS-1417: an owner's message no turn took is listed for the master", () => {
  it('lists his dropped message until his thread is answered, and leaves chatter out', async () => {
    const id = await roomId();
    const room = await roomById(id);
    if (!room) throw new Error('no room');
    const old = new Date(Date.now() - HELD_MESSAGE_MAX_AGE_MS - 60_000).toISOString();
    // his message, and a member's chatter, both waited past the bound with no turn taking them
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, actor_key, input, external_id, created_at)
      VALUES (${id}::uuid, ${w.projectId}, 'owner-thread-1417', 'message_in', 'member', ${chat.alice.userId},
              '{"text": "Đâu đưa cái hướng dẫn có UI đây xem", "addressed": "nobody"}'::jsonb, 'owner-msg-1417', ${old}::timestamptz),
             (${id}::uuid, ${w.projectId}, 'owner-elsewhere-1422', 'message_in', 'member', ${chat.alice.userId},
              '{"text": "Còn bản kia thì sao?", "addressed": "nobody"}'::jsonb, 'owner-msg-1422', ${old}::timestamptz),
             (${id}::uuid, ${w.projectId}, 'chatter-thread-1417', 'message_in', 'member', ${chat.bob.userId},
              '{"text": "ăn trưa chưa", "addressed": "nobody"}'::jsonb, 'chatter-msg-1417', ${old}::timestamptz)`);
    expect(await dropHeldTooLong(room)).toBeGreaterThanOrEqual(3);
    const owed = async () => (await mastersPorts().unhandledRoomMessagesOwed?.(w.projectId)) ?? [];
    // [DROPPED_TOLD_NOWHERE] before the fix: the master's owed line held nothing of it
    expect(await owed()).toEqual([
      expect.objectContaining({
        rid: chat.rid,
        code: 'HELD_TOO_LONG',
        count: 2,
        threads: expect.arrayContaining(['owner-thread-1417', 'owner-elsewhere-1422']),
      }),
    ]);
    // ISS-1421: a judge reads the same owed line with its checkout's credential, with no master
    // verdict call and writing nothing; [OWED_UNREADABLE] before the fix: no such read answered
    const judged = await owedLineAsAJudge();
    expect(judged.owedLine).toContain(`room ${chat.rid}, HELD_TOO_LONG`);
    expect(judged.owedLine).toContain('owner-thread-1417');
    expect(judged.owedLine).toContain('owner-elsewhere-1422');
    expect(judged.owedLine).not.toContain('chatter-thread-1417');
    // ISS-1422: a reply in another thread naming his message answers it, as support.reply records one;
    // [ANSWERED_ELSEWHERE_STILL_OWED] before the fix: it stayed on the owed line
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input)
      VALUES (${id}::uuid, ${w.projectId}, 'owner-elsewhere-1422', 'routed', 'session', 'answered_elsewhere',
              '{"message": "owner-msg-1422", "thread": "owner-thread-1417", "reply": "reply-elsewhere-1422"}'::jsonb)`);
    expect(await owed()).toEqual([
      expect.objectContaining({ count: 1, threads: ['owner-thread-1417'] }),
    ]);
    // a report in his thread answers nobody's request (ISS-1417), so it is still owed
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, external_id)
      VALUES (${id}::uuid, ${w.projectId}, 'owner-thread-1417', 'routed', 'session', 'master_post',
              '{"text": "Bản 0.310.0 đã kiểm.", "report": "release 0.310.0"}'::jsonb, 'report-1422')`);
    expect(await owed()).toEqual([
      expect.objectContaining({ count: 1, threads: ['owner-thread-1417'] }),
    ]);
    // answered in his thread, it is owed no more
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, input, external_id)
      VALUES (${id}::uuid, ${w.projectId}, 'owner-thread-1417', 'reply', 'session',
              '{"text": "Em gửi anh hướng dẫn."}'::jsonb, 'reply-1417')`);
    expect(await owed()).toEqual([]);
  });
});
