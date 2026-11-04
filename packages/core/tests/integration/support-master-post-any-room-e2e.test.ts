import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/channel.ts
// @direct-test-of packages/core/src/support/routes.ts
// @direct-test-of packages/contracts/src/support-channel.ts
//
// ISS-943: sid-desk's master had no way to post its release line into a thread of #sid-email, the
// support room its project binds, so the orchestrator relayed it by hand as the bot. The master's
// door takes every room kind its project binds: a support room the product's users read, in an
// asker's thread or at its top level as news for everyone, held to the rules that room's bot keeps
// toward users. A room no binding of the project names, a room whose binding is switched off and a
// thread of another room are refused by name, and nothing is posted.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;

const post = (body: unknown, token = w.owner) =>
  api(token, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const refusalOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string; detail: string }[] } }).error?.refusals?.[0];
const said = (res: { status: number; body: unknown }) => [res.status, refusalOf(res)?.code];
const topLines = () => chat.linesIn(chat.rid).filter((l) => !l.tmid);
const threadLines = (thread: string) => chat.linesIn(chat.rid).filter((l) => l.tmid === thread);

const RESULT = 'Bản sửa đã lên: hộp thư giờ hiện đúng tên người gửi, bạn thử lại giúp nhé.';
const NEWS = 'Bản cập nhật mới đã lên: thư trả lời giờ giữ nguyên tên người gửi.';

/** `who` writes in the support room, and the room has recorded it. */
async function asks(text: string): Promise<string> {
  const id = await chat.say(chat.bob, text);
  await expect
    .poll(
      async () =>
        (
          await rows<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM support_actions
             WHERE project_id = ${w.projectId}::uuid AND thread = ${id} AND kind = 'message_in'`)
        )[0]?.n,
      { timeout: 20_000 },
    )
    .toBe(1);
  return id;
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  // a support binding over one group, read by the product's users: #sid-email's shape
  await w.bind({ product: 'Sid mail desk' });
}, 120_000);

afterAll(() => w.stop());

describe("ISS-943: a master posts in its project's support room", () => {
  it("answers in an asker's thread, as the room's bot, recorded as the master's", async () => {
    const asked = await asks('Hộp thư của tôi hiện sai tên người gửi');
    const res = await post({ text: RESULT, rid: chat.rid, thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: asked });
    expect(threadLines(asked).map((l) => l.text)).toEqual([RESULT]);
    expect(topLines()).toEqual([]);
    const [act] = await rows<{ kind: string; by: string }>(sql`
      SELECT kind, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post' AND thread = ${asked}`);
    expect(act).toEqual({ kind: 'routed', by: w.ownerId });
  });

  it("finds the asker's thread with no rid named", async () => {
    const asked = await asks('Thư gửi đi bị chậm');
    const res = await post({ text: RESULT, thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(threadLines(asked).map((l) => l.text)).toEqual([RESULT]);
  });

  it("refuses an internal code in the users' room, and a mention of anyone but the asker", async () => {
    const asked = await asks('Khi nào sửa xong?');
    const coded = await post({ text: 'Đã xong ISS-12, commit 3971924c4.', thread: asked });
    expect(said(coded), JSON.stringify(coded.body)).toEqual([400, 'SUPPORT_INTERNAL_CODE']);
    const mention = await post({ text: `@alice ${RESULT}`, thread: asked });
    expect(said(mention), JSON.stringify(mention.body)).toEqual([409, 'SUPPORT_MENTION_REFUSED']);
    expect(threadLines(asked)).toEqual([]);
  });

  it('posts news for everyone at its top level, naming nobody, at most once an hour', async () => {
    const named = await post({ text: `@bob ${NEWS}`, rid: chat.rid });
    expect(said(named), JSON.stringify(named.body)).toEqual([409, 'SUPPORT_MENTION_REFUSED']);
    expect(topLines()).toEqual([]);
    const res = await post({ text: NEWS, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { rid: string }).rid).toBe(chat.rid);
    expect(topLines().map((l) => l.text)).toEqual([NEWS]);
    const again = await post({ text: NEWS, rid: chat.rid });
    expect(said(again), JSON.stringify(again.body)).toEqual([409, 'SUPPORT_ANNOUNCE_LIMIT']);
    expect(topLines()).toHaveLength(1);
  });

  it('asks for the room by rid where the project binds no room the team reads, posting nothing', async () => {
    const res = await post({ text: NEWS });
    expect(said(res), JSON.stringify(res.body)).toEqual([400, 'SUPPORT_ROOM_AMBIGUOUS']);
    expect(refusalOf(res)?.detail).toContain(chat.rid);
  });

  it("refuses a thread of the users' room no member wrote in", async () => {
    const own = topLines()[0]?.id as string;
    const res = await post({ text: RESULT, rid: chat.rid, thread: own });
    expect(said(res), JSON.stringify(res.body)).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    expect(threadLines(own)).toEqual([]);
  });

  it('refuses a thread of another room, by the room the chat server places it in', async () => {
    const elsewhere = await chat.sayIn(chat.rid3, chat.bob, 'Một câu hỏi ở nhóm khác');
    const before = chat.linesIn(chat.rid).length + chat.linesIn(chat.rid3).length;
    const named = await post({ text: RESULT, rid: chat.rid, thread: elsewhere });
    expect(said(named), JSON.stringify(named.body)).toEqual([
      409,
      'SUPPORT_THREAD_OF_ANOTHER_ROOM',
    ]);
    expect(refusalOf(named)?.detail).toContain(chat.rid3);
    const unnamed = await post({ text: RESULT, thread: elsewhere });
    expect(said(unnamed)).toEqual([409, 'SUPPORT_THREAD_OF_ANOTHER_ROOM']);
    const none = await post({ text: RESULT, rid: chat.rid, thread: 'noSuchThread01' });
    expect(said(none)).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    expect(chat.linesIn(chat.rid).length + chat.linesIn(chat.rid3).length).toBe(before);
  });

  it('refuses a room no binding of the project names, and a caller who cannot write it', async () => {
    const res = await post({ text: NEWS, rid: 'not-a-room' });
    expect(said(res)).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
    const stranger = await post({ text: NEWS, rid: chat.rid }, w.stranger);
    expect(stranger.status).toBe(403);
  });

  it('refuses the room once its binding is switched off, by name, and posts nothing', async () => {
    const asked = await asks('Còn lỗi tên người gửi không?');
    const before = chat.linesIn(chat.rid).length;
    await rows(sql`
      UPDATE integration_bindings SET active = false
       WHERE connection_id = ${w.rcConnectionId}::uuid`);
    const top = await post({ text: NEWS, rid: chat.rid });
    expect(said(top), JSON.stringify(top.body)).toEqual([409, 'SUPPORT_ROOM_SWITCHED_OFF']);
    expect(refusalOf(top)?.detail).toContain('switched off');
    const inThread = await post({ text: RESULT, rid: chat.rid, thread: asked });
    expect(said(inThread)).toEqual([409, 'SUPPORT_ROOM_SWITCHED_OFF']);
    expect(chat.linesIn(chat.rid).length).toBe(before);
  });
});
