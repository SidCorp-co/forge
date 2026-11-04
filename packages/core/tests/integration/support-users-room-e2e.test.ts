import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api, userToken } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock } from '../helpers/support-agent-world.js';
import { type Act, code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/screen.ts
// @direct-test-of packages/core/src/support/checks.ts
// @direct-test-of packages/core/src/integrations/rocketchat/support-binding.ts
//
// ISS-872 (owner trial 2026-11-02): a channel agent's group the product's users read took four
// unasked top-level "Cần quyết định…" posts in five minutes, each a project question in internal
// codes. A master posts top level only in a room the team reads, and into a users' room only into an
// asker's thread; a question for the owner goes only to the binding's owner room; and a post into a
// users' room holding an issue key, an MR or PR number, an environment variable name, a sha or a
// credential word is refused by name, nothing posted. Order numbers and PO codes stay.
//
// The world binds the agent over two groups: rid, read by users, and rid2, the owner's room.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
const CHECK = { name: 'morning-check', at: '01:30', ask: 'Read the supplier error counts today.' };

const post = (body: unknown) =>
  api(owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const codeOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string }[] } }).error?.refusals?.[0]?.code;
const topLines = (rid: string) => chat.linesIn(rid).filter((l) => !l.tmid);
const allLines = () => chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;

// the four posts of the trial, in their shape
const FOUR = [
  'Cần quyết định: ISS-89 nên merge hay mở lại?',
  'Cần quyết định: ISS-103 sửa nginx ConfigMap thế nào?',
  'Cần quyết định: ISS-32 đặt VIRTUAL_MACHINES_*_KEY ở đâu?',
  'Cần quyết định: MR !5050 làm lộ credential, có xoay key không?',
];

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
  const users = await w.retarget({
    agent: {
      ...agentBlock([w.devTarget], chat.rid2),
      readers: 'users',
      checks: [{ ...CHECK, rid: chat.rid }],
    },
  });
  if (users.status >= 300) throw new Error(`binding users: ${JSON.stringify(users.body)}`);
  await w.settleWarm();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-872: the binding names the owner room among its groups', () => {
  it('refuses an owner room the agent does not answer, by name', async () => {
    const res = await w.retarget({
      agent: { ...agentBlock([w.devTarget], 'GRPnot-bound'), readers: 'users' },
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('SUPPORT_OWNER_ROOM_UNKNOWN');
    expect(JSON.stringify(res.body)).toContain('GRPnot-bound');
  });

  it('reads the owner room as the team and the other group as users', async () => {
    const got = await api(owner, 'GET', `/api/projects/${w.projectId}/support/rooms`);
    const readers = Object.fromEntries(
      (got.body.rooms as { rid: string; readers: string }[]).map((r) => [r.rid, r.readers]),
    );
    expect(readers).toEqual({ [chat.rid]: 'users', [chat.rid2]: 'team' });
  });
});

describe("ISS-872: a master's post reaches a users' room only in an asker's thread", () => {
  it('refuses the four top-level posts of the trial in the users room, posting nothing', async () => {
    const before = allLines();
    for (const text of FOUR) {
      const res = await post({ text, rid: chat.rid });
      expect([res.status, codeOf(res)], JSON.stringify(res.body)).toEqual([
        409,
        'SUPPORT_MASTER_POST_USERS_ROOM',
      ]);
      expect(JSON.stringify(res.body)).toContain(chat.rid2);
    }
    expect(topLines(chat.rid)).toEqual([]);
    expect(allLines()).toBe(before);
  });

  it('posts a top-level post naming no room in the owner room, the one the team reads', async () => {
    const REVIEW = 'Hôm nay: hai thay đổi đã lên, một việc chờ anh quyết định.';
    const res = await post({ text: REVIEW });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { rid: string }).rid).toBe(chat.rid2);
    expect(topLines(chat.rid2).map((l) => l.text)).toEqual([REVIEW]);
    expect(topLines(chat.rid)).toEqual([]);
  });

  it("answers in an asker's thread of the users room in plain words, and refuses a code there", async () => {
    const asked = (await w.hear(() => chat.say(chat.bob, 'Nhờ gửi lại đơn PO001453760102901'))).id;
    const coded = await post({ text: 'Đã xong ISS-89, commit 3971924c4.', thread: asked });
    expect([coded.status, codeOf(coded)], JSON.stringify(coded.body)).toEqual([
      400,
      'SUPPORT_INTERNAL_CODE',
    ]);
    expect(w.threadLines(chat.rid, asked)).toEqual([]);
    const plain = 'Đã gửi lại đơn PO001453760102901, số 1453760102901.';
    const res = await post({ text: plain, thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(w.threadLines(chat.rid, asked).map((l) => l.text)).toEqual([plain]);
  });
});

describe("ISS-872: a post into a users' room holding an internal code is refused by name", () => {
  const CASES: [string, string, string][] = [
    ['issue key', 'Lỗi này đã có ở ISS-89.', 'ISS-89'],
    ['MR or PR number', 'Đã sửa trong !5050.', '!5050'],
    ['MR or PR number', 'Đã sửa trong PR #123.', 'PR #123'],
    [
      'environment variable name',
      'Thiếu VIRTUAL_MACHINES_*_KEY trên máy.',
      'VIRTUAL_MACHINES_*_KEY',
    ],
    ['commit sha', 'Bản sửa là 3971924c4.', '3971924c4'],
    ['credential word', 'Cần đổi token của nhà cung cấp.', 'token'],
    ['credential word', 'Đang làm key rotation.', 'key rotation'],
  ];

  it('refuses each code kind in a reply, naming the kind and the shape that passes', async () => {
    const outs: Record<string, unknown>[] = [];
    let plain: Record<string, unknown> = {};
    const before = allLines();
    const asked = await w.hear(
      () => chat.say(chat.bob, 'Đơn 1453760102901 của tôi bị lỗi?'),
      async (_t, act: Act, message) => {
        for (const [, text] of CASES) {
          outs.push(await act({ action: 'reply', thread: message().thread, text }));
        }
        expect(allLines()).toBe(before);
        plain = await act({
          action: 'reply',
          thread: message().thread,
          text: 'Đơn 1453760102901 (PO001453760102901) đã được gửi lại.',
        });
      },
    );
    CASES.forEach(([kind, , quote], i) => {
      expect(code(outs[i]), JSON.stringify(outs[i])).toBe('SUPPORT_INTERNAL_CODE');
      expect(JSON.stringify(outs[i])).toContain(`${kind} \\"${quote}\\"`);
      expect(JSON.stringify(outs[i])).toContain('Say it in plain words');
    });
    expect(plain.isError, JSON.stringify(plain)).toBe(false);
    expect(w.threadLines(chat.rid, asked.id).map((l) => l.text)).toEqual([
      'Đơn 1453760102901 (PO001453760102901) đã được gửi lại.',
    ]);
  });

  it('refuses an announcement holding a code, and its refusal spends no hour', async () => {
    let coded: Record<string, unknown> = {};
    let plain: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'Hệ thống có bảo trì không?'),
      async (_t, act: Act) => {
        coded = await act({
          action: 'announce',
          rid: chat.rid,
          text: 'Bảo trì cho ISS-103 lúc 22:00.',
        });
        plain = await act({
          action: 'announce',
          rid: chat.rid,
          text: 'Hệ thống bảo trì lúc 22:00.',
        });
      },
    );
    expect(code(coded), JSON.stringify(coded)).toBe('SUPPORT_INTERNAL_CODE');
    expect(plain.isError, JSON.stringify(plain)).toBe(false);
    expect(topLines(chat.rid).map((l) => l.text)).toEqual(['Hệ thống bảo trì lúc 22:00.']);
  });

  it('refuses a check finding holding a code, and posts the plain one', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    await w.settleWarm();
    let done = false;
    const outs: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      const check = turn.messages.find((m) => m.thread.startsWith('check:'))?.thread;
      if (!check || done) return;
      outs.push(
        await (act as Act)({
          action: 'check_result',
          check,
          finding: 'SUPPLIER_API_KEY sắp hết hạn.',
        }),
      );
      outs.push(
        await (act as Act)({
          action: 'check_result',
          check,
          finding: 'Kết nối nhà cung cấp sắp hết hạn.',
        }),
      );
      done = true;
    };
    expect(await fireDueChecks(new Date('2026-11-02T01:30:00Z'))).toBe(1);
    await expect.poll(() => done, { timeout: 20_000 }).toBe(true);
    expect(code(outs[0]), JSON.stringify(outs[0])).toBe('SUPPORT_INTERNAL_CODE');
    expect(outs[1]?.isError, JSON.stringify(outs[1])).toBe(false);
    expect(topLines(chat.rid).map((l) => l.text)).toContain('Kết nối nhà cung cấp sắp hết hạn.');
  });
});

describe('ISS-872: a question for the owner goes only to the owner room', () => {
  it('refuses ask_owner in the users room, posting nothing', async () => {
    let out: Record<string, unknown> = {};
    const before = allLines();
    await w.hear(
      () => chat.say(chat.bob, 'Có cần chủ dự án duyệt không?'),
      async (_t, act: Act, message) => {
        out = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'Anh có đồng ý gửi lại đơn hôm nay không?',
        });
      },
    );
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_NOT_THE_OWNER_ROOM');
    expect(JSON.stringify(out)).toContain(`read by the product's users`);
    expect(JSON.stringify(out)).toContain(chat.rid2);
    expect(allLines()).toBe(before);
    const [refused] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'ask_owner' AND kind = 'routed'`);
    expect(refused?.n).toBe(0);
  });

  it('asks in a thread of the owner room, and refuses its top level', async () => {
    let top: Record<string, unknown> = {};
    let asked: Record<string, unknown> = {};
    const thread = await w.hear(
      () => chat.sayIn(chat.rid2, chat.alice, 'Có việc gì cần tôi quyết không?'),
      async (_t, act: Act, message) => {
        top = await act({
          action: 'ask_owner',
          rid: chat.rid2,
          thread: 'top',
          question: 'Gửi lại đơn hôm nay nhé?',
        });
        asked = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'Anh có đồng ý gửi lại đơn hôm nay không?',
        });
      },
    );
    expect(code(top), JSON.stringify(top)).toBe('SUPPORT_NOT_THE_OWNER_ROOM');
    expect(asked.isError, JSON.stringify(asked)).toBe(false);
    expect(w.threadLines(chat.rid2, thread.id).map((l) => l.text)).toEqual([
      '@alice Anh có đồng ý gửi lại đơn hôm nay không?',
    ]);
  });

  it('asks nothing where the binding names no owner room', async () => {
    const bare = await w.retarget({
      agent: { ...agentBlock([w.devTarget], chat.rid2), ownerRoom: undefined, readers: 'team' },
    });
    expect(bare.status, JSON.stringify(bare.body)).toBeLessThan(300);
    await w.settleWarm();
    let out: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'Hỏi chủ dự án giúp tôi?'),
      async (_t, act: Act, message) => {
        out = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'Gửi lại đơn nhé?',
        });
      },
    );
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_NOT_THE_OWNER_ROOM');
    expect(JSON.stringify(out)).toContain('agent.ownerRoom');
  });
});
