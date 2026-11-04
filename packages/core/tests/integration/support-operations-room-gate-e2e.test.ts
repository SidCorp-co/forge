import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { announce } from '../../src/support/channel.js';
import { checkResult } from '../../src/support/checks.js';
import { dayThreadFor } from '../../src/support/question-task.js';
import { insertAction, type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/support/grants.ts
// @direct-test-of packages/core/src/support/thread.ts
// @direct-test-of packages/core/src/support/channel.ts
// @direct-test-of packages/core/src/support/checks.ts
// @direct-test-of packages/core/src/support/question-task.ts
//
// ISS-933: the warm sweep declares forge's shared Forge-Communicate operations room, where people
// and other bots talk. Two things hold there. The room answers only when addressed: a message that
// does not name the bot is kept as the thread's context and handed to no session. And nothing reaches
// the room's top level: an announcement, the day's questions opener and a check's finding land in
// the project's own thread its binding records, or are refused by name with none recorded.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona:
    'You are Babo. You coordinate Forge and delivery for the team: projects, issues, runners and releases.',
  grants: ['read'],
};
const THREAD = 'XQHEiGjSv8HTytmpY';
/** A person in the room who talks to the team, never to the bot. */
const CHUONGLD = { userId: 'u-chuongld', username: 'chuongld' };

const w = new SupportWorld();
let chat: StandInRocketChat;
let slug = '';
let bindingPath = '';
let room: RoomRow;

const codeOf = (out: { ok: boolean; refusals?: { code: string; detail: string }[] }) =>
  out.ok ? null : out.refusals?.[0]?.code;

/** The binding's target with `operations` replaced, written through the binding door. */
async function writeOperations(operations: Record<string, unknown>) {
  const got = await api(w.owner, 'GET', bindingPath);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const document = got.body.document as { target: Record<string, unknown> };
  return api(w.owner, 'PUT', bindingPath, {
    baseRevision: got.body.revision,
    document: { ...document, target: { ...document.target, operations } },
  });
}

/** The room's `message_in` row for one chat message, once the handler has recorded it. */
async function recorded(id: string) {
  let row: { delivered: boolean; addressed: string | null } | undefined;
  await expect
    .poll(
      async () => {
        [row] = await rows<{ delivered: boolean; addressed: string | null }>(sql`
          SELECT delivered_at IS NOT NULL AS delivered, input->>'addressed' AS addressed
            FROM support_actions
           WHERE room_id = ${room.id}::uuid AND kind = 'message_in' AND external_id = ${id}`);
        return Boolean(row);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return row as { delivered: boolean; addressed: string | null };
}

const turnsCarrying = (id: string) =>
  w.box.asked().filter((t) => t.messages.some((m) => m.message === id));

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: chat.serverUrl, role: BABO },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  w.rcConnectionId = String((rc.body.connection as { id: string }).id);
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  bindingPath = `/api/projects/${w.projectId}/bindings/${String(b?.id)}`;
  // the bot listens on the room, as the binding door's world does
  const { startRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
  await startRocketChatManager();
  await settleOutbox();
  await w.settleWarm();
  const [declared] = await roomsOfProject(w.projectId);
  if (!declared) throw new Error('the operations room was not declared');
  room = declared;
}, 120_000);

afterAll(() => w.stop());

describe('an operations room answers only when addressed (ISS-933)', () => {
  it("keeps chuongld's plain top-level message as context: no turn, no post, no reaction", async () => {
    const linesBefore = (await chat.botLines()).length;
    const plain = await chat.sayIn(
      chat.rid,
      CHUONGLD,
      'Mọi người ơi, bản build mới lên rồi, ai rảnh xem giúp nhé',
    );
    const row = await recorded(plain);
    expect(row, 'recorded as context, handed to nobody').toEqual({
      delivered: true,
      addressed: null,
    });
    // a message that names the bot is handed on, and the plain one is in no turn before or with it
    const asked = await chat.sayIn(chat.rid, chat.bob, '@supportbot bản build mới lên chưa?');
    await expect.poll(() => turnsCarrying(asked).length, { timeout: 20_000 }).toBe(1);
    await w.settleWarm();
    expect(turnsCarrying(plain), 'no session was handed the plain message').toEqual([]);
    expect((await chat.botLines()).length, 'nothing was posted by any door').toBe(linesBefore);
    expect(chat.reactions.filter((r) => r.messageId === plain)).toEqual([]);
  });

  it('hands a message that names the bot to the session, marked as for it', async () => {
    const asked = await chat.sayIn(chat.rid, chat.alice, '@supportbot ai đang giữ bản phát hành?');
    await expect.poll(() => turnsCarrying(asked).length, { timeout: 20_000 }).toBe(1);
    expect(await recorded(asked)).toEqual({ delivered: true, addressed: 'you' });
    const [turn] = turnsCarrying(asked);
    expect(turn?.messages.find((m) => m.message === asked)?.text).toContain('ai đang giữ');
  });

  it('answers every message where the binding says so', async () => {
    const put = await writeOperations({ scope: 'forge', answers: 'every-message' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await settleOutbox();
    await w.settleWarm();
    const plain = await chat.sayIn(chat.rid, CHUONGLD, 'Có ai xem log hôm qua chưa?');
    await expect.poll(() => turnsCarrying(plain).length, { timeout: 20_000 }).toBe(1);
    const back = await writeOperations({ scope: 'forge' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    await settleOutbox();
    await w.settleWarm();
  });
});

describe('nothing reaches the top level of a forge-scope operations room (ISS-933)', () => {
  const NEWS = 'Bản phát hành mới đã lên, mọi thứ chạy bình thường.';
  const OPENER = 'Câu hỏi hôm nay cho chủ dự án';
  const FINDING = 'Kiểm tra sáng nay: hàng đợi đang dồn, cần xem lại.';

  /** A handed Forge question and a check firing, as core writes each into the room. */
  async function seed(tag: string) {
    const handed = `handed-${tag}`;
    const check = `check-${tag}`;
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: null,
      thread: handed,
      kind: 'message_in',
      actorKind: 'core',
      input: { forgeQuestion: `q-${tag}`, round: 1 },
    });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: null,
      thread: check,
      kind: 'message_in',
      actorKind: 'core',
      input: { check: tag },
    });
    return { handed, check };
  }

  it('refuses an announcement, the day opener and a check finding by name with no thread recorded', async () => {
    const before = chat.linesIn(chat.rid).length;
    const { handed, check } = await seed('none');
    const said = await announce(room, { text: NEWS });
    expect(codeOf(said)).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(said.ok ? '' : said.refusals[0]?.detail).toContain(
      `operations.threads["${chat.rid}"]["${slug}"]`,
    );
    const opened = await dayThreadFor(room, { thread: handed, opener: OPENER });
    expect(codeOf(opened)).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    const found = await checkResult(room, { check, finding: FINDING });
    expect(codeOf(found)).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(chat.linesIn(chat.rid).length, 'nothing was posted').toBe(before);
    // the firing's one result was not taken by the refusal: it can still be answered
    const [claimed] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE room_id = ${room.id}::uuid AND kind = 'check_result' AND thread = ${check}`);
    expect(claimed?.n).toBe(0);
  });

  it('posts each into the project’s recorded thread once the binding records it', async () => {
    const put = await writeOperations({
      scope: 'forge',
      threads: { [chat.rid]: { [slug]: THREAD } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // the binding change re-tells the room's session; it settles before the box closes
    await settleOutbox();
    await w.settleWarm();
    const before = chat.linesIn(chat.rid).length;
    const { handed, check } = await seed('recorded');
    const said = await announce(room, { text: NEWS });
    expect(said.ok, JSON.stringify(said)).toBe(true);
    const opened = await dayThreadFor(room, { thread: handed, opener: OPENER });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(opened.ok ? opened.value.thread : null, "the day's thread is the project's").toBe(
      THREAD,
    );
    const found = await checkResult(room, { check, finding: FINDING });
    expect(found.ok, JSON.stringify(found)).toBe(true);
    const posted = chat.linesIn(chat.rid).slice(before);
    expect(posted.map((l) => [l.tmid, l.text])).toEqual([
      [THREAD, NEWS],
      [THREAD, OPENER],
      [THREAD, FINDING],
    ]);
  });
});
