import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { confidentLanguageOf } from '../../src/conversations/index.js';
import { runWithPatScope } from '../../src/credentials/pat-scope.js';
import { db } from '../../src/db/client.js';
import { ownerForgeAct as forgeAct } from '../../src/support/owner-forge-act.js';
import { insertAction, type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { raiseTechnical } from '../../src/support/technical-channel.js';
import { roomAuth, threadConversationOf } from '../../src/support/thread.js';
import { api } from '../helpers/api.js';
import { ecosystemDoc, JOIN_HEAD, settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestRequirement, rows, seedOrg } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';
import { inUntrustedFrame } from '../helpers/untrusted-frame.js';

// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/support/technical-turn.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/support/owner-decision-acts.ts
// @direct-test-of packages/core/src/support/owner-membership-act.ts
// @direct-test-of packages/core/src/ecosystem/membership-acts.ts
//
// ISS-1299 (owner 2026-11-18): in forge's own thread of Forge-Communicate he gave the room full
// rights to link ePOD into the ecosystem; its agent answered that it was being done, an act it had
// no door to, and a minute later a raise posted a master's English answer under "Forge asks:",
// asking him again, in the third person, what he had just settled. Replayed here: his word makes the
// link as him, a raise that does not answer his message is held, words in English for a thread he
// writes in Vietnamese are refused, and the one line posted is his language with no template lead.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona: 'You are Babo. You coordinate Forge and delivery for the team.',
  grants: ['read'],
};
const THREAD = 'XQHEiGjSv8HTytmpY';
const MASTER_WORDS =
  'Linking ePOD into the Forge ecosystem needs a person signed in to Forge, and chuongld can do both if he is admin of the org and of ePOD.';

const w = new SupportWorld();
let chat: StandInRocketChat;
let room: RoomRow;
let slug = '';
let eco = '';

const codeOf = (out: { ok: boolean; refusals?: { code: string }[] }) =>
  out.ok ? null : out.refusals?.[0]?.code;
const detailOf = (out: { ok: boolean; refusals?: { detail: string }[] }) =>
  out.ok ? '' : (out.refusals?.map((r) => r.detail).join(' ') ?? '');
const threadLines = () => chat.linesIn(chat.rid).filter((l) => l.tmid === THREAD);

let seq = 0;

/** `text` written by alice in the project's thread, as the room records a member's message; its id. */
async function aliceSays(text: string): Promise<string> {
  const { namespace } = await roomAuth(room);
  const conversation = await threadConversationOf(room, namespace, THREAD);
  seq += 1;
  const id = `alice-${seq}-${Date.now()}`;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: conversation.id,
    thread: THREAD,
    kind: 'message_in',
    actorKind: 'member',
    actorKey: chat.alice.userId,
    actorLabel: chat.alice.username,
    input: { text },
    externalId: id,
    deliveredAt: new Date(),
  });
  return id;
}

/** The owner's Forge act, made inside a session turn, whose token an operations room's write acts on. */
const ownerForgeAct = (...args: Parameters<typeof forgeAct>) =>
  runWithPatScope({ projectIds: null, tokenId: randomUUID(), agency: 'agent', grant: ['*'] }, () =>
    forgeAct(...args),
  );

/** The answer the room's agent posted in the thread, as its reply is recorded. */
async function agentAnswered(text: string): Promise<void> {
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: THREAD,
    kind: 'reply',
    actorKind: 'session',
    input: { text },
    externalId: `reply-${Date.now()}`,
  });
}

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
        target: {
          provider: 'rocketchat',
          rids: [chat.rid],
          operations: { scope: 'forge', threads: { [chat.rid]: { [slug]: THREAD } } },
        },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  await settleOutbox();
  await w.settleWarm();
  const [declared] = await roomsOfProject(w.projectId);
  if (!declared) throw new Error('the operations room was not declared');
  room = declared;
  // alice is the project's owner in Forge, by a confirmed link, and an admin of the steward org
  const namespace = new URL(chat.serverUrl).host;
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespace}, ${chat.alice.userId}, ${chat.alice.username}, ${w.ownerId}, 'channel_email_match')`);
  const steward = await seedOrg(w.ownerId);
  const formed = await api(w.owner, 'POST', '/api/ecosystems', {
    baseRevision: null,
    document: ecosystemDoc(steward, 'forge-platform', 'FP'),
  });
  expect(formed.status, JSON.stringify(formed.body)).toBe(200);
  eco = 'forge-platform';
  // a joining project's head is read from its source host; the stand-in has none
  const { projectHead } = await import('../../src/ecosystem/builder-head.js');
  vi.spyOn(projectHead, 'read').mockResolvedValue({
    ok: true,
    value: {
      sha: JOIN_HEAD,
      ref: 'refs/heads/main',
      readAt: new Date().toISOString(),
      via: 'source-host',
    },
  });
  await createTestRequirement(w.projectId, 801, 'Export reports to CSV');
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1299: the technical thread speaks to the owner in one voice, his language, on his word', () => {
  it('replays 02:46-02:47: his full-rights word links the project as him, no second ask, one Vietnamese line', async () => {
    const said = await aliceSays(
      '@babo project epod đang nằm sẵn trong org mà, với bạn có toàn quyền mà?',
    );
    await agentAnswered(
      'Dạ, đã ghi nhận: không chờ anh, nối ePOD vào hệ sinh thái forge ngay trong tổ chức. Việc này đang được làm.',
    );
    const before = threadLines().length;
    // the master's answer, raised as it arrived: held, naming his message and the promise standing
    const reask = await raiseTechnical(room, { thread: THREAD, need: 'ask', text: MASTER_WORDS });
    expect(codeOf(reask), JSON.stringify(reask)).toBe('SUPPORT_RAISE_THREAD_UNREAD');
    expect(detailOf(reask)).toContain(said);
    expect(detailOf(reask)).toContain('toàn quyền');
    expect(detailOf(reask)).toContain('đang được làm');
    // ISS-1425: his words and the answer standing reach the turn inside the untrusted frame
    expect(inUntrustedFrame(detailOf(reask), 'toàn quyền')).toBe(true);
    expect(inUntrustedFrame(detailOf(reask), 'đang được làm')).toBe(true);
    expect(detailOf(reask)).toContain('support.owner_forge_act');
    expect(threadLines().length, 'no second ask was posted').toBe(before);
    // his word makes the link as him: the steward's invite, then the member's accept
    for (const act of ['membership.invite', 'membership.accept']) {
      const made = await ownerForgeAct(room, {
        thread: THREAD,
        message: said,
        project: slug,
        act,
        item: eco,
      });
      expect(made.ok, JSON.stringify(made)).toBe(true);
    }
    const [member] = await rows<{ state: string }>(sql`
      SELECT m.state FROM ecosystem_memberships m JOIN ecosystems e ON e.id = m.ecosystem_id
       WHERE e.slug = ${eco} AND m.project_id = ${w.projectId}::uuid`);
    expect(member?.state).toBe('active');
    // once, in his language, answering him: posted as written, with no template lead
    const done = 'Dạ anh, em đã nối dự án vào hệ sinh thái forge-platform xong rồi ạ.';
    const told = await raiseTechnical(room, {
      thread: THREAD,
      need: 'finding',
      text: done,
      answers: said,
    });
    expect(told.ok, JSON.stringify(told)).toBe(true);
    const posted = threadLines()
      .slice(before)
      .map((l) => l.text);
    expect(posted).toEqual([done]);
    expect(confidentLanguageOf(posted[0])).toBe('vi');
    // his message is answered now: the next raise is not held on it
    const next = await raiseTechnical(room, {
      thread: THREAD,
      need: 'finding',
      text: 'Dạ, hàng đợi của dự án đang chạy bình thường anh nhé.',
    });
    expect(next.ok, JSON.stringify(next)).toBe(true);
  });

  it('posts English words into the thread he writes in Vietnamese: the guess is a hint, never a refusal (ISS-1451)', async () => {
    const said = await aliceSays('Em kiểm tra giúp anh xem bản mới đã lên chưa nhé');
    const before = threadLines().length;
    const english = 'The new release is live on dev and every check is green.';
    const posted = await raiseTechnical(room, {
      thread: THREAD,
      need: 'finding',
      text: english,
      answers: said,
    });
    expect(posted.ok, JSON.stringify(posted)).toBe(true);
    expect(
      threadLines()
        .slice(before)
        .map((l) => l.text),
    ).toEqual([english]);
  });

  it('posts no raise on an item he settled a minute earlier; the act is made as him', async () => {
    const said = await aliceSays('REQ-801 để sau đi em, chờ bản báo cáo mới');
    const before = threadLines().length;
    const ask = await raiseTechnical(room, {
      thread: THREAD,
      need: 'approval',
      text: 'Anh muốn hoãn phần xuất báo cáo CSV lại hay làm tiếp ạ?',
    });
    expect(codeOf(ask), JSON.stringify(ask)).toBe('SUPPORT_RAISE_THREAD_UNREAD');
    expect(threadLines().length).toBe(before);
    const made = await ownerForgeAct(room, {
      thread: THREAD,
      message: said,
      project: slug,
      act: 'requirement.defer',
      item: 'REQ-801',
      reason: 'chờ bản báo cáo mới',
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const [deferred] = await rows<{ decided_by: string }>(sql`
      SELECT d.decided_by FROM requirement_deferrals d JOIN requirements r ON r.id = d.requirement_id
       WHERE r.project_id = ${w.projectId}::uuid AND r.req_seq = 801`);
    expect(deferred?.decided_by).toBe(w.ownerId);
  });

  it('refuses by name an act his Needs you can owe that no door from chat makes, naming where', async () => {
    // a production deploy's confirm has its room act since ISS-1441; a preview's approval has none yet
    const said = await aliceSays('Em duyệt bản preview giúp anh luôn nhé');
    const out = await ownerForgeAct(room, {
      thread: THREAD,
      message: said,
      project: slug,
      act: 'preview.approve',
      item: 'pr-12',
    });
    expect(codeOf(out), JSON.stringify(out)).toBe('SUPPORT_FORGE_ACT_NO_DOOR');
    expect(detailOf(out)).toContain("the preview's page");
    expect(detailOf(out)).toContain('never that it is being done');
  });
});
