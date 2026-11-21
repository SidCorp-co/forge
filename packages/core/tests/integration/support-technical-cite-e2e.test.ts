import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { namespaceFromServerUrl } from '../../src/integrations/rocketchat/namespace.js';
import { owedThreadOf } from '../../src/support/owner-owed-raise.js';
import { answerHandedQuestion } from '../../src/support/question-task.js';
import { questionThreadOf } from '../../src/support/rules.js';
import { insertAction, type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { postTechnical } from '../../src/support/technical-channel.js';
import { roomAuth, threadConversationOf } from '../../src/support/thread.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  rows,
} from '../helpers/factories.js';
import { approvalOf, cutAndAsk } from '../helpers/release-approval.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { type Act, code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/technical-thread-room.ts
// @direct-test-of packages/core/src/support/question-task.ts
// @direct-test-of packages/core/src/support/release-decision.ts
// @direct-test-of packages/core/src/support/release-decide-as.ts
// @direct-test-of packages/core/src/support/access.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/one-raise.ts
// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/owner-owed-raise.ts
// @direct-test-of packages/core/src/support/thread.ts
// @direct-test-of packages/core/src/support/service.ts
// @direct-test-of packages/core/src/support/images.ts
// @direct-test-of packages/core/src/support/kept-answers.ts
//
// ISS-1347 (FB-757, FB-762, FB-768, FB-786, FB-794, FB-796): since ISS-1271 the owner is asked in
// his project's thread of the organization's shared operations room, and answers there. His plain
// "ok" there settled nothing: answer_question refused it SUPPORT_ANSWER_NOT_THE_OWNER, release_decision
// SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE or SUPPORT_ROOM_AMBIGUOUS, a question- notice thread could
// not be closed, and every ask_owner was followed by a raise_owed of the same question ("why do you
// keep making me say ok", 2026-11-21). His word there is now citable by the project's agents; anyone
// else's, or one in another project's thread, is still refused by name.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona: 'You are Babo. You coordinate Forge and delivery for the team.',
  grants: ['read'],
};
// a 1x1 PNG, as the owner's screenshot
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const w = new AgentWorld();
let ops = '';
let slug = '';
let siblingId = '';
let tech = '';
let agent: RoomRow;
let shared: RoomRow;
let seq = 8700;

const link = () =>
  db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
    SELECT 'rocketchat', ${namespaceFromServerUrl(w.stand.serverUrl)}, ${OWNER_ID}, ${w.ownerId}, 'channel_email_match'
     WHERE NOT EXISTS (SELECT 1 FROM assistant_speaker_links WHERE external_id = ${OWNER_ID})`);

beforeAll(async () => {
  await w.openAgent();
  ops = w.stand.rid3;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const sibling = await createTestProject(w.ownerId, { orgId: String(home?.org_id) });
  await addProjectMember(sibling.id, w.ownerId, 'owner');
  siblingId = sibling.id;
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: w.stand.serverUrl, role: BABO },
    secrets: { authToken: w.stand.bot.authToken, userId: w.stand.bot.userId },
    bindings: [
      {
        projectId: sibling.id,
        role: 'service',
        target: { provider: 'rocketchat', rids: [ops], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  await settleOutbox();
  await w.settleWarm();
  await db.execute(
    sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`,
  );
  const mine = (await roomsOfProject(w.projectId)).find((r) => r.rid === w.stand.rid);
  const theirs = (await roomsOfProject(siblingId)).find((r) => r.rid === ops);
  if (!mine || !theirs) throw new Error('the agent room or the shared operations room is missing');
  agent = mine;
  shared = theirs;
  // the project's own thread of the shared room, opened by its first need
  const opened = await postTechnical(agent, 'Kênh kỹ thuật của dự án', '/need');
  if (!opened.ok || !opened.value.thread) throw new Error(JSON.stringify(opened));
  tech = opened.value.thread;
  await link();
}, 120_000);

afterAll(() => w.stop());

/** A message the chat server signed for `by`, recorded on the shared room's row as inbound records it. */
async function plant(id: string, by: { key: string; label: string }, text: string, thread = tech) {
  w.stand.uploads.set(id, { bytes: PNG, mime: 'image/png' });
  await insertAction({
    roomId: shared.id,
    projectId: shared.projectId,
    conversationId: null,
    kind: 'message_in',
    actorKind: 'member',
    actorKey: by.key,
    actorLabel: by.label,
    thread,
    externalId: id,
    input: {
      text,
      images: [
        {
          name: 'clip.png',
          mime: 'image/png',
          ref: `${w.stand.serverUrl}/file-upload/${id}/clip.png`,
        },
      ],
    },
  });
}
const OWNER = { key: OWNER_ID, label: 'alice' };

/** A run parked on a new issue of the project, owed by a person. */
async function parked(prompt: string): Promise<string> {
  const issue = await createTestIssue(w.projectId, w.ownerId, ++seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const { askQuestion } = await import('../../src/questions/index.js');
  const id = randomUUID();
  await askQuestion({
    id,
    projectId: w.projectId,
    issueId: issue.id,
    askedBy: w.ownerId,
    prompt,
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'his call' },
  } as Parameters<typeof askQuestion>[0]);
  return id;
}

const question = async (id: string) =>
  (
    await rows<{ status: string; steps: Record<string, unknown>[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${id}::uuid`,
    )
  )[0];

/** The agent's acts on a turn bob opens in its own group; `thread` is his. */
async function acting(does: (act: Act, thread: string) => Promise<void>): Promise<void> {
  await w.hear(
    () => w.stand.say(w.stand.bob, 'any news from the owner?'),
    async (_t, act, message) => does(act, String(message().thread)),
  );
}

/**
 * Forge hands the agent a notice thread, as the sweeps do: an owed- item on a conversation of its
 * own (`handOwnerOwed`), a question- round on none (`handQuestionToChannelAgent`).
 */
async function notice(thread: string, input: Record<string, unknown>) {
  const conversationId = thread.startsWith('owed-')
    ? (await threadConversationOf(agent, (await roomAuth(agent)).namespace, thread)).id
    : null;
  await insertAction({
    roomId: agent.id,
    projectId: agent.projectId,
    conversationId,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note: 'a task Forge handed', ...input },
    externalId: thread,
    deliveredAt: new Date(),
  });
}

// before the owner writes in the technical thread: a raise there is held while his words are unread
describe('ISS-1347: a notice thread closes, and one Forge question is put to the owner once', () => {
  it('closes a question- notice thread with silent, and raises from it with technical', async () => {
    const id = await parked('Unchi feed: keep or drop?');
    const thread = questionThreadOf(id, 1);
    await notice(thread, { forgeQuestion: id, round: 1 });
    const outs: Record<string, unknown>[] = [];
    await acting(async (act) => {
      outs.push(await act({ action: 'silent', thread, reason: 'already put to the owner' }));
      outs.push(
        await act({
          action: 'technical',
          thread,
          need: 'finding',
          text: 'The Unchi feed waits on your call',
        }),
      );
    });
    // [THREAD_UNKNOWN] before the fix: no member has written in a question- thread
    expect(
      outs.map((o) => o.isError),
      JSON.stringify(outs),
    ).toEqual([false, false]);
  });

  it('puts one Forge question to the owner once, by ask_owner or raise_owed, naming the first raise', async () => {
    const asked = await parked('AI description un-defer now?');
    const raised = await parked('Feed import at noon?');
    const owedOfAsked = owedThreadOf(`question:${asked}`);
    const owedOfRaised = owedThreadOf(`question:${raised}`);
    await notice(owedOfAsked, { owed: `question:${asked}` });
    await notice(owedOfRaised, { owed: `question:${raised}` });
    const outs: Record<string, unknown>[] = [];
    await acting(async (act, thread) => {
      outs.push(
        await act({
          action: 'ask_owner',
          thread,
          question: 'Shall we bring the AI description back now?',
          forgeQuestion: asked,
        }),
      );
      outs.push(
        await act({
          action: 'raise_owed',
          thread: owedOfAsked,
          text: 'Bring the AI description back?',
        }),
      );
      outs.push(
        await act({
          action: 'raise_owed',
          thread: owedOfRaised,
          text: 'Run the feed import at noon?',
        }),
      );
      outs.push(
        await act({
          action: 'ask_owner',
          thread,
          question: 'Should the feed import run at noon today?',
          forgeQuestion: raised,
        }),
      );
      outs.push(await act({ action: 'silent', thread: owedOfAsked, reason: 'asked already' }));
    });
    const [ask, again, raise, askAgain, silent] = outs;
    expect(ask?.isError, JSON.stringify(ask)).toBe(false);
    // [RAISED_TWICE] before the fix: the owed- notice put the same question to him again
    expect(code(again), JSON.stringify(again)).toBe('SUPPORT_OWED_ALREADY_RAISED');
    expect(JSON.stringify(again)).toContain(`Forge question ${asked} was already put to the owner`);
    expect(raise?.isError, JSON.stringify(raise)).toBe(false);
    expect(code(askAgain), JSON.stringify(askAgain)).toBe('SUPPORT_OWNER_ALREADY_ASKED');
    expect(JSON.stringify(askAgain)).toContain(`from thread ${owedOfRaised}`);
    expect(silent?.isError, JSON.stringify(silent)).toBe(false);
    const posted = w.threadLines(ops, tech).map((l) => l.text);
    expect(posted.filter((t) => t.includes('AI description'))).toHaveLength(1);
    expect(posted.filter((t) => t.includes('feed import'))).toHaveLength(1);
  });
});

describe("ISS-1347: the owner's word in the project's technical channel settles what he owes", () => {
  it('records his answer cited from the technical thread as his, the room named by its rid or not', async () => {
    const first = await parked('Google connect: OAuth client, service account, or later?');
    const second = await parked('Release on tests alone?');
    await plant('M-ans-1', OWNER, 'Dùng OAuth client');
    await plant('M-ans-2', OWNER, 'ok');
    const outs: Record<string, unknown>[] = [];
    await acting(async (act) => {
      outs.push(
        await act({
          action: 'answer_question',
          thread: tech,
          forgeQuestion: first,
          message: 'M-ans-1',
        }),
      );
      // FB-794: the room named is the technical channel's, never SUPPORT_ROOM_AMBIGUOUS
      outs.push(
        await act({
          action: 'answer_question',
          thread: tech,
          forgeQuestion: second,
          message: 'M-ans-2',
          rid: ops,
        }),
      );
    });
    // [NOT_THE_OWNER] before the fix: no message the owner wrote in this group
    expect(
      outs.map((o) => o.isError),
      JSON.stringify(outs),
    ).toEqual([false, false]);
    expect((await question(first))?.steps.at(-1)).toMatchObject({
      answerText: 'Dùng OAuth client',
      answeredBy: w.ownerId,
    });
    expect((await question(second))?.status).toBe('answered');
  });

  it("refuses by name an answer in another person's words or in another project's thread, recording nothing", async () => {
    const id = await parked('May the nightly import run at noon?');
    await plant('M-bob', { key: w.stand.bob.userId, label: 'bob' }, 'yes, run it at noon');
    await plant('M-other', OWNER, 'ok', 'T-another-project');
    const outs: Record<string, unknown>[] = [];
    await acting(async (act, thread) => {
      outs.push(
        await act({ action: 'answer_question', thread: tech, forgeQuestion: id, message: 'M-bob' }),
      );
      outs.push(
        await act({ action: 'answer_question', thread, forgeQuestion: id, message: 'M-other' }),
      );
    });
    expect(outs.map(code), JSON.stringify(outs)).toEqual([
      'SUPPORT_ANSWER_NOT_THE_OWNER',
      'SUPPORT_ANSWER_NOT_THE_OWNER',
    ]);
    expect(JSON.stringify(outs[0])).toContain('@bob');
    expect(JSON.stringify(outs[1])).toContain("outside your project's own thread");
    expect((await question(id))?.status).toBe('open');
  });

  it('reads a picture the owner posted in the technical thread', async () => {
    await plant('M-shot', OWNER, 'Cái này');
    let read: Record<string, unknown> & { content?: { type: string; data?: string }[] } = {};
    await acting(async (act) => {
      read = await act({ action: 'image', message: 'M-shot', n: 1 });
    });
    expect(read.isError, JSON.stringify(read)).toBe(false);
    const block = read.content?.find((c) => c.type === 'image');
    expect(Buffer.from(block?.data ?? '', 'base64')).toEqual(PNG);
  });

  it("lets the operations room's own agent record his answer there, as his", async () => {
    const id = await parked('Refund un-defer now?');
    await plant('M-ops', OWNER, 'Có, làm luôn');
    // [NOT_A_SUPPORT_ROOM] before the fix: supportAct refused answer_question in an operations room
    const out = await answerHandedQuestion(shared, {
      thread: tech,
      forgeQuestion: id,
      message: 'M-ops',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect((await question(id))?.steps.at(-1)).toMatchObject({ answeredBy: w.ownerId });
  });

  it("decides a release on his go in the technical thread, cited from any thread the agent holds or by the channel's rid", async () => {
    const { approvalId: viaRid } = await cutAndAsk(w.projectId, w.ownerId, '0.31.0');
    const { approvalId: viaOwn } = await cutAndAsk(w.projectId, w.ownerId, '0.32.0');
    await plant('M-go-1', OWNER, 'Ok cho lên 0.31.0');
    await plant('M-go-2', OWNER, 'Ok cho lên 0.32.0');
    const outs: Record<string, unknown>[] = [];
    await acting(async (act, thread) => {
      const go = { action: 'release_decision', project: slug, decision: 'approve' };
      // FB-794: naming the technical rid was SUPPORT_ROOM_AMBIGUOUS
      outs.push(await act({ ...go, thread: tech, message: 'M-go-1', version: '0.31.0', rid: ops }));
      // and naming the thread it was handed in, SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE
      outs.push(await act({ ...go, thread, message: 'M-go-2', version: '0.32.0' }));
    });
    expect(
      outs.map((o) => o.isError),
      JSON.stringify(outs),
    ).toEqual([false, false]);
    for (const id of [viaRid, viaOwn]) {
      const stored = await approvalOf(id);
      expect(stored).toMatchObject({ decision: 'approved', decided_by_user: w.ownerId });
      expect(stored?.reason).toContain(ops);
    }
  });

  it('keeps his answer while his chat account is no Forge account, and records it once an admin names it', async () => {
    await db.execute(sql`DELETE FROM assistant_speaker_links WHERE external_id = ${OWNER_ID}`);
    w.stand.emails.delete(OWNER_ID);
    const id = await parked('Which mailbox takes the sales alias?');
    await plant('M-kept', OWNER, 'Hộp sales@');
    let out: Record<string, unknown> = {};
    await acting(async (act) => {
      out = await act({
        action: 'answer_question',
        thread: tech,
        forgeQuestion: id,
        message: 'M-kept',
      });
    });
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_ANSWER_NOT_THE_OWNER');
    expect(JSON.stringify(out)).toContain('noted');
    expect(JSON.stringify(out)).toContain('speaker-links/named');
    expect((await question(id))?.status).toBe('open');
    const kept = await rows<{ input: Record<string, unknown> }>(sql`
      SELECT input FROM support_actions WHERE kind = 'answer_kept' AND input ->> 'questionId' = ${id}`);
    expect(kept).toHaveLength(1);
    await w.settleWarm();
    const named = await api(w.owner, 'POST', `/api/projects/${w.projectId}/speaker-links/named`, {
      source: 'rocketchat',
      externalId: OWNER_ID,
      userId: w.ownerId,
      reason: 'FB-757: the chat server reports no address for the owner',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    await expect
      .poll(async () => (await question(id))?.status, { timeout: 10_000 })
      .toBe('answered');
    expect((await question(id))?.steps.at(-1)).toMatchObject({
      answerText: 'Hộp sales@',
      answeredBy: w.ownerId,
    });
  });
});
