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
// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/support/warm.ts
// @direct-test-of packages/core/src/support/report-thread.ts
// @direct-test-of packages/core/src/support/report-thread-route.ts
// @direct-test-of packages/core/src/support/thread-conversation.ts
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
/** The line Forge opens a room's report thread with, in the room's language (ISS-1224). */
const ANCHOR = 'Báo cáo của trợ lý';
/** The bot's lines at a room's top level, outside any thread. */
const topOf = (rid: string) => chat.linesIn(rid).filter((l) => !l.tmid);
type RoomView = { id: string; rid: string; reportThread: string | null; reportThreadBy: string };
const roomOf = async (rid: string) => {
  const got = await api(owner, 'GET', `/api/projects/${w.projectId}/support/rooms`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return (got.body as { rooms: RoomView[] }).rooms.find((r) => r.rid === rid);
};
const nameThread = (token: string, roomId: string, body: unknown) =>
  api(token, 'PUT', `/api/projects/${w.projectId}/support/rooms/${roomId}/report-thread`, body);

describe("the master's post in its project's room (ISS-862)", () => {
  // ISS-1467: rid is the agent's owner room, which only the team reads; rid2 is a support room whose
  // binding says `readers: team`, which is no team's room by that word, so a master's post there is refused
  it('refuses a support room whose binding says readers: team, naming master-tells, and posts nothing', async () => {
    const res = await post(owner, { text: REVIEW, rid: chat.rid2 });
    expect([res.status, codeOf(res)]).toEqual([409, 'SUPPORT_MASTER_POST_USERS_ROOM']);
    expect(JSON.stringify(res.body)).toContain('master-tells');
    expect(chat.linesIn(chat.rid2).filter((l) => !l.tmid)).toEqual([]);
    expect(chat.linesIn(chat.rid).filter((l) => !l.tmid)).toEqual([]);
  });

  it('refuses a room the project does not bind, by name', async () => {
    const res = await post(owner, { text: REVIEW, rid: 'not-a-room' });
    expect([res.status, codeOf(res)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
  });

  // ISS-933: the forge daily review (2026-11-03) was refused on a room its binding names but nobody
  // had declared, sent to an unchanged binding save that declares nothing. The door declares it
  // itself and posts, and the room is listed from then on.
  it('declares a room its binding names but nobody declared, posts there, and lists it', async () => {
    const UNDECLARED = 'room-bound-not-declared';
    const widen = (rid: string | null) =>
      rows(sql`
        UPDATE integration_bindings
           SET config = jsonb_set(config, '{rids}', ${
             rid === null
               ? sql`(config->'rids') - ${UNDECLARED}`
               : sql`(config->'rids') || to_jsonb(${rid}::text)`
           })
         WHERE project_id = ${w.projectId}::uuid AND provider = 'rocketchat'`);
    const listed = async () => {
      const got = await api(owner, 'GET', `/api/projects/${w.projectId}/support/rooms`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return (got.body as { rooms: { rid: string }[] }).rooms.map((r) => r.rid);
    };
    await widen(UNDECLARED);
    try {
      expect(await listed(), 'bound, never declared').not.toContain(UNDECLARED);
      // declared by the post's own door, then refused as any support room is (ISS-1467): not the team's
      const res = await post(owner, { text: REVIEW, rid: UNDECLARED });
      expect([res.status, codeOf(res)], JSON.stringify(res.body)).toEqual([
        409,
        'SUPPORT_MASTER_POST_USERS_ROOM',
      ]);
      expect(topOf(UNDECLARED)).toEqual([]);
      expect(await listed()).toContain(UNDECLARED);
      // a room no binding names stays unknown, and nothing is declared for it
      const unknown = await post(owner, { text: REVIEW, rid: 'not-a-room' });
      expect(codeOf(unknown)).toBe('SUPPORT_ROOM_UNKNOWN');
      expect(await listed()).not.toContain('not-a-room');
    } finally {
      await widen(null);
      await rows(sql`
        DELETE FROM support_actions WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post'`);
    }
  });

  // ISS-933's root: a room bound before the code that declares its kind shipped, or whose
  // declaration failed, is declared by the warm sweep, with no save and no post to wait for
  it('declares a room its binding names but nobody declared on the next warm sweep', async () => {
    const SWEPT = 'room-bound-swept';
    const widen = (add: boolean) =>
      rows(sql`
        UPDATE integration_bindings
           SET config = jsonb_set(config, '{rids}', ${
             add
               ? sql`(config->'rids') || to_jsonb(${SWEPT}::text)`
               : sql`(config->'rids') - ${SWEPT}`
           })
         WHERE project_id = ${w.projectId}::uuid AND provider = 'rocketchat'`);
    const listed = async () =>
      (
        (await api(owner, 'GET', `/api/projects/${w.projectId}/support/rooms`)).body as {
          rooms: { rid: string }[];
        }
      ).rooms.map((r) => r.rid);
    await widen(true);
    try {
      expect(await listed()).not.toContain(SWEPT);
      const { warmColdRooms } = await import('../../src/support/index.js');
      await warmColdRooms();
      expect(await listed()).toContain(SWEPT);
    } finally {
      await widen(false);
    }
  });

  it('refuses a caller who cannot write the project', async () => {
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const res = await post(stranger, { text: REVIEW, rid: chat.rid });
    expect(res.status).toBe(403);
  });
});

// ISS-1224 (owner 2026-11-12): a master's post naming no thread landed at the top level of support
// and team rooms. It goes in the room's report thread: the one a person named, or one standing
// thread Forge opens once per room with one anchor line. Where none can be opened it is refused by
// name, and a thread unknown in the room is refused as the report thread, with nothing saved.
describe("the master's post naming no thread goes in the room's report thread (ISS-1224)", () => {
  const NEXT = 'Ngày mai: kiểm tra lại phần thông báo trên dev.';
  const MINE = 'Báo cáo tuần này: phần thông báo đã lên dev.';

  it('opens one standing thread with one anchor line, posts inside it, and reuses it', async () => {
    expect((await roomOf(chat.rid))?.reportThread).toBeNull();
    // two posts at once open one thread
    const [first, second] = await Promise.all([
      post(owner, { text: REVIEW, rid: chat.rid }),
      post(owner, { text: NEXT, rid: chat.rid }),
    ]);
    expect([first.status, second.status], JSON.stringify([first.body, second.body])).toEqual([
      201, 201,
    ]);
    expect(topOf(chat.rid).map((l) => l.text)).toEqual([ANCHOR]);
    const anchor = String(topOf(chat.rid)[0]?.id);
    // the answer names the thread it landed in, and that it is the room's report thread (ISS-1433)
    expect(first.body).toMatchObject({ rid: chat.rid, thread: anchor, landedIn: 'report-thread' });
    expect(second.body).toMatchObject({ rid: chat.rid, thread: anchor });
    expect(
      w
        .threadLines(chat.rid, anchor)
        .map((l) => l.text)
        .sort(),
    ).toEqual([REVIEW, NEXT].sort());
    expect(await roomOf(chat.rid)).toMatchObject({ reportThread: anchor, reportThreadBy: 'forge' });
    // a later post reuses it, with no new anchor
    const again = await post(owner, { text: REVIEW, rid: chat.rid });
    expect(again.body).toMatchObject({ thread: anchor });
    expect(topOf(chat.rid).map((l) => l.text)).toEqual([ANCHOR]);
    expect(w.threadLines(chat.rid, anchor)).toHaveLength(3);
    const acts = await rows<{ kind: string; tool: string; thread: string; by: string | null }>(sql`
      SELECT a.kind, a.tool, a.thread, a.input->>'by' AS by
        FROM support_actions a JOIN support_rooms r ON r.id = a.room_id
       WHERE a.project_id = ${w.projectId}::uuid AND r.rid = ${chat.rid}
         AND a.tool IN ('master_post', 'report_thread')
       ORDER BY a.created_at`);
    expect(acts.filter((a) => a.tool === 'report_thread')).toEqual([
      { kind: 'operation', tool: 'report_thread', thread: anchor, by: null },
    ]);
    expect(acts.filter((a) => a.tool === 'master_post')).toHaveLength(3);
    expect(acts.filter((a) => a.tool === 'master_post')[0]).toEqual({
      kind: 'announced',
      tool: 'master_post',
      thread: anchor,
      by: w.ownerId,
    });
  });

  it("posts in the thread a person named for the room's reports", async () => {
    const mine = chat.wroteWhileAway(chat.rid, chat.alice, MINE, new Date());
    const room = await roomOf(chat.rid);
    const named = await nameThread(owner, String(room?.id), { thread: mine });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(named.body).toMatchObject({ reportThread: mine, reportThreadBy: 'person' });
    expect(await roomOf(chat.rid)).toMatchObject({ reportThread: mine, reportThreadBy: 'person' });
    const tops = topOf(chat.rid).length;
    const res = await post(owner, { text: NEXT, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: mine });
    expect(w.threadLines(chat.rid, mine).map((l) => l.text)).toEqual([NEXT]);
    expect(topOf(chat.rid)).toHaveLength(tops);
  });

  it('refuses a thread unknown in the room as its report thread, and saves nothing', async () => {
    const room = await roomOf(chat.rid);
    const was = room?.reportThread;
    const unknown = await nameThread(owner, String(room?.id), { thread: 'no-such-thread' });
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    expect(JSON.stringify(unknown.body)).toContain('Nothing was saved');
    const elsewhere = chat.wroteWhileAway(chat.rid2, chat.bob, MINE, new Date());
    const other = await nameThread(owner, String(room?.id), { thread: elsewhere });
    expect([other.status, codeOf(other)]).toEqual([409, 'SUPPORT_THREAD_OF_ANOTHER_ROOM']);
    const noRoom = await nameThread(owner, '00000000-0000-4000-8000-000000000000', {
      thread: elsewhere,
    });
    expect([noRoom.status, codeOf(noRoom)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    expect((await nameThread(stranger, String(room?.id), { thread: elsewhere })).status).toBe(403);
    expect((await nameThread(owner, String(room?.id), { thread: 'a/b' })).status).toBe(400);
    expect((await roomOf(chat.rid))?.reportThread).toBe(was);
  });

  it('refuses by name where the report thread cannot be opened, and posts nothing', async () => {
    // the owner room's standing thread is forgotten, so the post must open one, which the server refuses
    await rows(sql`
      UPDATE support_rooms SET report_thread = NULL, report_thread_by = NULL
       WHERE project_id = ${w.projectId}::uuid AND rid = ${chat.rid}`);
    const before = chat.linesIn(chat.rid).length;
    chat.topLevelRefused = true;
    try {
      const res = await post(owner, { text: REVIEW, rid: chat.rid });
      expect([res.status, codeOf(res)]).toEqual([503, 'SUPPORT_POST_NEEDS_THREAD']);
      expect(JSON.stringify(res.body)).toContain('/report-thread');
    } finally {
      chat.topLevelRefused = false;
    }
    expect(chat.linesIn(chat.rid)).toHaveLength(before);
    expect((await roomOf(chat.rid))?.reportThread).toBeNull();
  });
});

// ISS-871: a master's result goes back into the thread of the person who asked for it, as a switched
// hand bot's did. The thread is one of the named room or of the one bound room holding it (ISS-943:
// by the project's record or by the chat server); any other is refused by name and nothing is posted.
describe("the master's result in the asker's own thread (ISS-871)", () => {
  const RESULT = 'Đã xong: đơn PO 1453 đã gửi lại cho nhà cung cấp, bạn kiểm tra giúp nhé.';
  let asked = '';

  it('finds the room holding the thread and answers there, recorded as the caller’s', async () => {
    asked = await chat.sayIn(chat.rid, chat.alice, 'Nhờ master gửi lại PO 1453');
    const res = await post(owner, { text: RESULT, thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: asked });
    expect(w.threadLines(chat.rid, asked).map((l) => l.text)).toEqual([RESULT]);
    const [act] = await rows<{ kind: string; thread: string; by: string }>(sql`
      SELECT kind, thread, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post' AND thread = ${asked}`);
    expect(act).toEqual({ kind: 'routed', thread: asked, by: w.ownerId });
  });

  it('refuses a thread no member wrote in, and one of another room than the named, posting nothing', async () => {
    const before = chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;
    const none = await post(owner, { text: RESULT, thread: 'no-such-thread' });
    expect([none.status, codeOf(none)]).toEqual([404, 'SUPPORT_THREAD_UNKNOWN']);
    const other = await post(owner, { text: RESULT, thread: asked, rid: chat.rid2 });
    expect([other.status, codeOf(other)]).toEqual([409, 'SUPPORT_THREAD_OF_ANOTHER_ROOM']);
    expect(JSON.stringify(other.body)).toContain(`thread ${asked} is in room ${chat.rid}`);
    const gone = await post(owner, { text: RESULT, thread: asked, rid: 'not-a-room' });
    expect([gone.status, codeOf(gone)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
    expect(chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length).toBe(before);
  });

  // ISS-943: a thread of a team room nobody recorded (an app's post, or the bot's own relayed one) is
  // still that room's, as the chat server places its first message; another room's is refused by name
  it("posts in a team room's thread no member wrote in, as the chat server places it", async () => {
    const app = chat.wroteWhileAway(chat.rid, chat.alice, 'Bản phát hành tối nay', new Date(), {
      bot: true,
    });
    const res = await post(owner, { text: RESULT, thread: app });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: app });
    expect(w.threadLines(chat.rid, app).map((l) => l.text)).toEqual([RESULT]);
    const other = await post(owner, { text: RESULT, thread: app, rid: chat.rid2 });
    expect([other.status, codeOf(other)]).toEqual([409, 'SUPPORT_THREAD_OF_ANOTHER_ROOM']);
    expect(w.threadLines(chat.rid2, app)).toEqual([]);
  });

  it('refuses a thread that is no message id, by its shape', async () => {
    const res = await post(owner, { text: RESULT, thread: 'a/b' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('thread');
  });
});

// ISS-1344 (FB-754): a thread's conversation was read off its OLDEST action, and a master's post the
// screen refused is recorded with no conversation, so a thread whose first master post was refused
// stayed unknown after a member wrote in it: on 2026-11-19 the room agent's thread read, in-flight
// read and reply there were each refused SUPPORT_THREAD_UNKNOWN. A thread no member wrote in is
// still refused.
describe("a thread a master's post opened is known once a member writes in it (ISS-1344)", () => {
  const OPENED = 'Sáng nay còn hai việc chờ anh trả lời.';
  const ANSWER = 'Đã ghi nhận câu trả lời của anh.';
  const codesOf = (out: Record<string, unknown>) =>
    JSON.stringify(out).match(/SUPPORT_[A-Z_]+/g) ?? [];
  /** A bot-opened thread whose first recorded action is a master post the screen refused. */
  const openedRefused = async () => {
    const root = chat.wroteWhileAway(chat.rid, chat.alice, 'Việc chờ', new Date(), { bot: true });
    const keyed = await post(owner, { text: `${OPENED} ISS-123`, thread: root });
    expect(codeOf(keyed), JSON.stringify(keyed.body)).toBe('SUPPORT_INTERNAL_CODE');
    const [first] = await rows<{ kind: string; conversation_id: string | null }>(sql`
      SELECT kind, conversation_id FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND thread = ${root} ORDER BY created_at LIMIT 1`);
    expect(first).toEqual({ kind: 'refused', conversation_id: null });
    return root;
  };

  it("admits the room agent's thread read, in-flight read and reply, and the reply posts", async () => {
    const root = await openedRefused();
    expect((await post(owner, { text: OPENED, thread: root })).status).toBe(201);
    const out: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'Anh chọn phương án một.', root),
      async (_turn, act) => {
        out.thread = await act({ action: 'thread', thread: root });
        out.inFlight = await act({ action: 'in_flight', thread: root });
        out.reply = await act({ action: 'reply', thread: root, text: ANSWER });
      },
    );
    expect(codesOf(out), JSON.stringify(out)).toEqual([]);
    await w.untilLine(chat.rid, root, (t) => t === ANSWER);
  });

  it('still refuses a thread no member wrote in', async () => {
    const quiet = await openedRefused();
    const out: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'Có ai ở đây không?'),
      async (_turn, act) => {
        out.reply = await act({ action: 'reply', thread: quiet, text: ANSWER });
      },
    );
    expect(codesOf(out), JSON.stringify(out)).toContain('SUPPORT_THREAD_UNKNOWN');
    expect(w.threadLines(chat.rid, quiet)).toEqual([]);
  });
});
