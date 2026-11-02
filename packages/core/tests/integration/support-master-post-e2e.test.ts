import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api, userToken } from '../helpers/api.js';
import { createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/routes.ts
//
// ISS-862: the project's master posts its daily review, in its own words, at the top level of the
// project's team room. Core writes none of the words: it picks the room, screens, posts and records
// who posted. A project binding several team rooms is told to name one; a room it does not bind,
// and a caller who cannot write the project, are refused by name, and nothing is posted.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
const post = (token: string, body: unknown) =>
  api(token, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const codeOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string }[] } }).error?.refusals?.[0]?.code;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
}, 120_000);

afterAll(() => w.stop());

const REVIEW = 'Hôm nay: 3 issue lên dev, 1 lỗi deploy đã sửa; mai làm tiếp phần thông báo.';

describe("the master's post in its project's room (ISS-862)", () => {
  it('asks which room where the project binds two, and posts nothing', async () => {
    const res = await post(owner, { text: REVIEW });
    expect([res.status, codeOf(res)]).toEqual([400, 'SUPPORT_ROOM_AMBIGUOUS']);
    expect(JSON.stringify(res.body)).toContain(chat.rid2);
    expect(chat.linesIn(chat.rid).filter((l) => !l.tmid)).toEqual([]);
  });

  it('refuses a room the project does not bind, by name', async () => {
    const res = await post(owner, { text: REVIEW, rid: 'not-a-room' });
    expect([res.status, codeOf(res)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
  });

  it('refuses a caller who cannot write the project', async () => {
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const res = await post(stranger, { text: REVIEW, rid: chat.rid });
    expect(res.status).toBe(403);
  });

  it('posts the words as given at the top level of the named room, recorded as the caller’s', async () => {
    const res = await post(owner, { text: REVIEW, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { rid: string }).rid).toBe(chat.rid);
    const top = chat.linesIn(chat.rid).filter((l) => !l.tmid);
    expect(top.map((l) => l.text)).toEqual([REVIEW]);
    expect(chat.linesIn(chat.rid2).filter((l) => !l.tmid)).toEqual([]);
    const [act] = await rows<{ kind: string; tool: string; by: string }>(sql`
      SELECT kind, tool, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post'`);
    expect(act).toEqual({ kind: 'announced', tool: 'master_post', by: w.ownerId });
  });
});

// ISS-871: a master's result goes back into the thread of the person who asked for it, as a switched
// hand bot's did. The thread is one a member wrote in, of the named room or of the one team room
// holding it; any other is refused by name and nothing is posted.
describe("the master's result in the asker's own thread (ISS-871)", () => {
  const RESULT = 'Đã xong: đơn PO 1453 đã gửi lại cho nhà cung cấp, bạn kiểm tra giúp nhé.';
  let asked = '';

  it('finds the room holding the thread and answers there, recorded as the caller’s', async () => {
    asked = (await w.hear(() => chat.sayIn(chat.rid2, chat.bob, 'Nhờ master gửi lại PO 1453'))).id;
    const res = await post(owner, { text: RESULT, thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid2, thread: asked });
    expect(w.threadLines(chat.rid2, asked).map((l) => l.text)).toEqual([RESULT]);
    expect(chat.linesIn(chat.rid2).filter((l) => !l.tmid)).toEqual([]);
    const [act] = await rows<{ kind: string; thread: string; by: string }>(sql`
      SELECT kind, thread, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post' AND thread = ${asked}`);
    expect(act).toEqual({ kind: 'routed', thread: asked, by: w.ownerId });
  });

  it('refuses a thread no member wrote in, and one of another room than the named, posting nothing', async () => {
    const before = chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;
    const none = await post(owner, { text: RESULT, thread: 'no-such-thread' });
    expect([none.status, codeOf(none)]).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    const other = await post(owner, { text: RESULT, thread: asked, rid: chat.rid });
    expect([other.status, codeOf(other)]).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    expect(JSON.stringify(other.body)).toContain(`thread ${asked} of ${chat.rid}`);
    const gone = await post(owner, { text: RESULT, thread: asked, rid: 'not-a-room' });
    expect([gone.status, codeOf(gone)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
    expect(chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length).toBe(before);
  });

  it('refuses a thread that is no message id, by its shape', async () => {
    const res = await post(owner, { text: RESULT, thread: 'a/b' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('thread');
  });
});
