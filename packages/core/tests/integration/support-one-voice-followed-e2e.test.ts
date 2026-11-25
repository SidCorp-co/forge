import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/one-voice.ts
// @direct-test-of packages/core/src/support/master-post.ts
//
// ISS-1406, Forge-Feedback 2026-11-22 (a channel agent's users' group, followed by the projects its
// feedback goes to): the room agent answered (03:21:48) and a followed project's master posted a
// contradicting line ten seconds later, both standing under one bot name. The thread had been told
// an item's result, so the master's post had to name that message as `followsUp` (ISS-969), and a
// follow-up never replaced anything: it stood beside the agent's newer answer.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let feId = '';
const FE = `adminhub-fe-${randomUUID().slice(0, 6)}`;

const TOLD = 'Bản sửa đã lên: biểu mẫu giờ gửi đủ trường sang hệ thống hỗ trợ.';
const ANSWER = 'Mình chưa thấy phiếu nào có đủ trường, bạn gửi thử một biểu mẫu nữa nhé.';
const FOLLOWED = 'Phiếu đã hiện đủ 7 trường, bạn không cần lưu lại cấu hình.';
const HOME = 'Phiếu đã hiện đủ 7 trường; bạn không cần làm gì thêm.';

const post = (projectId: string, text: string, thread: string, followsUp?: string) =>
  api(w.owner, 'POST', `/api/projects/${projectId}/support/master-posts`, {
    text,
    rid: chat.rid,
    thread,
    ...(followsUp ? { followsUp } : {}),
  });
const lines = (thread: string) =>
  chat
    .linesIn(chat.rid)
    .filter((l) => l.tmid === thread)
    .map((l) => l.text);

/** A member asks (in `thread` where given), and the room agent answers `text` there. */
async function answered(ask: string, text: string, thread?: string): Promise<string> {
  await w.settleWarm();
  let done = false;
  w.box.model = async (turn: Turn, act) => {
    const asked = turn.messages.find((m) => m.from !== 'forge');
    if (done || !asked) return;
    const out = await act({ action: 'reply', thread: asked.thread, text });
    expect(out, JSON.stringify(out)).not.toHaveProperty('error');
    done = true;
  };
  const id = await chat.say(chat.bob, ask, thread);
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return thread ?? id;
}

/** The agent's reply in `thread` reading `text`, as the chat server named it, and a second before it. */
async function replyOf(thread: string, text: string): Promise<{ id: string; at: string }> {
  const [row] = await rows<{ id: string; at: string }>(sql`
    SELECT external_id AS id, (created_at - interval '1 second')::text AS at FROM support_actions
     WHERE thread = ${thread} AND kind = 'reply' AND input->>'text' = ${text}`);
  if (!row) throw new Error(`no reply ${text} in ${thread}`);
  return row;
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  feId = (await createTestProject(w.ownerId, { orgId: String(home?.org_id) })).id;
  await addProjectMember(feId, w.ownerId, 'owner');
  await db.execute(sql`UPDATE projects SET slug = ${FE} WHERE id = ${feId}::uuid`);
  // the room agent answers the users' group and follows the other project (ISS-874)
  await w.bindTarget({
    rids: [chat.rid],
    agent: { product: 'AdminHub, the back office', readers: 'users', projects: [FE] },
  });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1406: one voice in a followed channel agent group', () => {
  it("a follow-up on a told result replaces the agent's newer answer, and the home master's replaces it", async () => {
    const thread = await answered('Biểu mẫu Pixelight gửi sang có đủ trường chưa?', TOLD);
    // the item's result was told in that reply (`support/result.ts`), so a master names it to follow up
    const told = await replyOf(thread, TOLD);
    const [room] = await rows<{ id: string }>(
      sql`SELECT id FROM support_rooms WHERE rid = ${chat.rid} AND project_id = ${w.projectId}::uuid`,
    );
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, output, created_at)
      VALUES (${String(room?.id)}, ${w.projectId}, ${thread}, 'result_told', 'core',
              '{"phase": "resolved", "feedbackKey": "FB-1"}'::jsonb,
              ${told.at}::timestamptz)`);
    await answered('Mình gửi thử rồi mà phiếu vẫn thiếu trường.', ANSWER, thread);
    expect(lines(thread)).toEqual([TOLD, ANSWER]);
    // ISS-1467: neither a followed project's master nor the home's follows up in a users' group
    // with its own words, and the agent's answer stands untouched
    const followed = await post(feId, FOLLOWED, thread, told.id);
    expect([followed.status, JSON.stringify(followed.body)]).toEqual([
      409,
      expect.stringContaining('SUPPORT_MASTER_POST_USERS_ROOM'),
    ]);
    const home = await post(w.projectId, HOME, thread, told.id);
    expect(home.status, JSON.stringify(home.body)).toBe(409);
    expect(lines(thread)).toEqual([TOLD, ANSWER]);
  });

  it("leaves the agent as the thread's one voice where a master names the told message too", async () => {
    const thread = await answered('Phiếu có trường số điện thoại chưa?', TOLD);
    const told = await replyOf(thread, TOLD);
    const followed = await post(feId, FOLLOWED, thread, told.id);
    expect(followed.status, JSON.stringify(followed.body)).toBe(409);
    expect(lines(thread)).toEqual([TOLD]);
  });
});

describe('ISS-1406: a master reads the thread before it posts', () => {
  const read = (projectId: string, thread: string, rid?: string, token = w.owner) =>
    api(
      token,
      'GET',
      `/api/projects/${projectId}/support/master-posts/threads/${thread}${rid ? `?rid=${rid}` : ''}`,
    );

  it('shows who posted what and when, the replaced answer as the post that stands, and no secret', async () => {
    const thread = await answered('Biểu mẫu báo lỗi đã gửi đi chưa?', TOLD);
    // a member pastes the bot's own credential: the read never hands it back
    await chat.say(chat.bob, `mã của mình là ${chat.bot.authToken}`, thread);
    await expect
      .poll(async () => ((await read(feId, thread)).body.posts as unknown[] | undefined)?.length)
      .toBe(3);
    const got = await read(feId, thread, chat.rid);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({ rid: chat.rid, thread, readers: 'users' });
    const posts = got.body.posts as { by: string; project?: string; name?: string; text: string }[];
    expect(posts.map((p) => [p.by, p.project ?? p.name])).toEqual([
      ['member', expect.any(String)],
      ['agent', expect.any(String)],
      ['member', expect.any(String)],
    ]);
    expect(posts[1]?.text).toBe(TOLD);
    expect(JSON.stringify(got.body)).not.toContain(chat.bot.authToken);
  });

  it('refuses a room its post does not reach, and a caller who cannot post', async () => {
    const thread = await answered('Còn trường địa chỉ?', TOLD);
    const elsewhere = await read(feId, thread, 'not-a-room');
    expect([elsewhere.status, JSON.stringify(elsewhere.body)]).toEqual([
      404,
      expect.stringContaining('Nothing was read.'),
    ]);
    const stranger = await read(feId, thread, chat.rid, w.stranger);
    expect(stranger.status).toBe(403);
  });
});
