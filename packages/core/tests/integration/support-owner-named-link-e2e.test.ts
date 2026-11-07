import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { randomUUID } from 'node:crypto';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/question-task.ts
// @direct-test-of packages/core/src/support/kept-answers.ts
// @direct-test-of packages/core/src/support/speaker-link.ts
// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/assistant/identity/routes.ts
// @direct-test-of packages/core/src/assistant/identity/named-links.ts
// @direct-test-of packages/core/src/assistant/identity/speaker-link.ts
//
// ISS-976 (FB-499, FB-563): the agenfold owner, named on the binding by his chat id, answered two
// parked questions in his own room, and neither was recorded: his chat account was linked to no Forge
// account, the chat server reports no address for it, and the refusal told the agent to ask him to
// link it, which the persona may not raise with him. A project admin now names the Forge account a
// chat account is; until then the owner's cited answer is kept, and it is recorded as his once.

const w = new AgentWorld();
let chat: StandInRocketChat;
let admin = '';
let adminId = '';
let member = '';
let outsiderId = '';
let seq = 9760;

const NAMED = () => `/api/projects/${w.projectId}/speaker-links/named`;

/** A run parked on a new issue of the project, asking the owner in words. */
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
    answer: { shape: 'free_text', needed: 'the owner’s call' },
  } as Parameters<typeof askQuestion>[0]);
  return id;
}

const question = async (id: string) =>
  (
    await rows<{ status: string; steps: Record<string, unknown>[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${id}::uuid`,
    )
  )[0];

/** The `question.answered` events for a question: what wakes the master who asked. */
const answeredEvents = async (id: string) =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pipeline_outbox
       WHERE type = 'question.answered' AND payload ->> 'questionId' = ${id}`)
  )[0]?.n ?? 0;

/** The answers kept for a question, with what became of each. */
const keptFor = async (questionId: string) =>
  rows<{ external_id: string; input: Record<string, unknown>; output: Record<string, unknown> }>(
    sql`SELECT external_id, input, output FROM support_actions
         WHERE kind = 'answer_kept' AND input ->> 'questionId' = ${questionId}`,
  );

/** The owner says `words` in his room, and the agent cites it as the answer to `questionId`. */
async function ownerAnswers(questionId: string, words: string) {
  let out: Record<string, unknown> = {};
  const said = await w.hear(
    () => chat.say(chat.alice, words),
    async (_turn, act, message) => {
      out = await act({
        action: 'answer_question',
        thread: message().thread,
        forgeQuestion: questionId,
        message: message().message ?? '',
      });
    },
  );
  return { out, messageId: said.id };
}

const refusalOf = (body: Record<string, unknown>) =>
  ((body.error as { refusals?: { code: string; detail?: string }[] } | undefined)?.refusals ??
    [])[0];

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const a = await createTestUser({ verified: true });
  adminId = a.id;
  await addProjectMember(w.projectId, a.id, 'admin');
  admin = await userToken(a.id);
  const m = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, m.id, 'member');
  member = await userToken(m.id);
  outsiderId = (await createTestUser({ verified: true })).id;
  // the chat server reports no address for the owner's account, as agenfold's does
  chat.emails.delete(OWNER_ID);
}, 120_000);

afterAll(() => w.stop());

describe('ISS-976: an unlinked named owner’s answer is kept, and the refusal names who acts', () => {
  let first = '';

  it('keeps the cited answer, and tells the agent who owes the setup step, never to ask him', async () => {
    first = await parked('Cut over with no downtime, or take a short downtime?');
    const { out, messageId } = await ownerAnswers(first, 'Không cần đâu, downtime chút không sao');
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_ANSWER_NOT_THE_OWNER');
    const detail = JSON.stringify(out);
    // the act and who owes it: a project admin naming his account, or the owner linking from Forge
    expect(detail).toContain('speaker-links/named');
    expect(detail).toContain('project admin');
    // what the agent may tell the room
    expect(detail).toContain('noted');
    // never: ask him to link it, or to edit his chat profile
    expect(detail).not.toContain('ask them to link');
    expect(detail).not.toMatch(/set one on the chat account|edit (his|their) (chat )?profile/i);
    expect((await question(first))?.status).toBe('open');
    const kept = await keptFor(first);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.input).toMatchObject({ message: messageId, questionId: first });
    expect(kept[0]?.output ?? null).toBeNull();
  });

  it('keeps one answer once, however often the agent cites it', async () => {
    const [kept] = await keptFor(first);
    const again = await w.hear(
      () => chat.say(chat.alice, 'ok'),
      async (_turn, act) => {
        await act({
          action: 'answer_question',
          thread: 'any',
          forgeQuestion: first,
          message: String(kept?.input.message),
        });
      },
    );
    expect(again.id).toBeTruthy();
    expect(await keptFor(first)).toHaveLength(1);
  });

  it('refuses the email-only link by name, naming the admin link as the other way', async () => {
    const out = await api(w.owner, 'POST', `/api/projects/${w.projectId}/speaker-links/proposals`, {
      source: 'rocketchat',
      externalId: OWNER_ID,
    });
    expect(out.status).toBeGreaterThanOrEqual(400);
    const refusal = refusalOf(out.body);
    expect(refusal?.code).toBe('SPEAKER_EMAIL_ABSENT');
    expect(refusal?.detail).toContain('speaker-links/named');
  });
});

describe('ISS-976: a project admin names the Forge account a chat account is', () => {
  it('refuses a member, an account outside the project, an unknown chat id, and no reason', async () => {
    const body = {
      source: 'rocketchat',
      externalId: OWNER_ID,
      userId: w.ownerId,
      reason: 'FB-563: the chat server reports no address for the owner',
    };
    const byMember = await api(member, 'POST', NAMED(), body);
    expect(byMember.status).toBe(403);
    const outsider = await api(admin, 'POST', NAMED(), { ...body, userId: outsiderId });
    expect(refusalOf(outsider.body)?.code, JSON.stringify(outsider.body)).toBe(
      'SPEAKER_NAMED_NOT_A_MEMBER',
    );
    const unknown = await api(admin, 'POST', NAMED(), { ...body, externalId: 'u-nobody' });
    expect(refusalOf(unknown.body)?.code, JSON.stringify(unknown.body)).toBe(
      'SPEAKER_NOT_ON_CHANNEL',
    );
    const { reason: _, ...unreasoned } = body;
    const noReason = await api(admin, 'POST', NAMED(), unreasoned);
    expect(noReason.status).toBe(400);
    const [n] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM speaker_link_namings`);
    expect(n?.n).toBe(0);
  });

  it('names the owner’s account, recorded with who, when and why, and records his kept answer once', async () => {
    const [q] = await rows<{ id: string }>(sql`
      SELECT input ->> 'questionId' AS id FROM support_actions WHERE kind = 'answer_kept' LIMIT 1`);
    const kept = String(q?.id);
    await w.settleWarm();
    const notes: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from === 'forge') notes.push(m.text);
    };
    const named = await api(admin, 'POST', NAMED(), {
      source: 'rocketchat',
      externalId: OWNER_ID,
      userId: w.ownerId,
      reason: 'FB-563: the chat server reports no address for the owner',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    const [row] = await rows<Record<string, unknown>>(sql`
      SELECT project_id, external_id, user_id, named_by, reason, named_at, undone_at
        FROM speaker_link_namings WHERE external_id = ${OWNER_ID}`);
    expect(row).toMatchObject({
      project_id: w.projectId,
      user_id: w.ownerId,
      named_by: adminId,
      reason: 'FB-563: the chat server reports no address for the owner',
      undone_at: null,
    });
    expect(row?.named_at).toBeTruthy();
    // his kept answer is recorded as him, once, and the master who asked wakes
    await expect.poll(async () => (await question(kept))?.status, { timeout: 10_000 }).toBe(
      'answered',
    );
    expect((await question(kept))?.steps.at(-1)).toMatchObject({
      answerText: 'Không cần đâu, downtime chút không sao',
      answeredBy: w.ownerId,
    });
    expect(await answeredEvents(kept)).toBe(1);
    expect((await keptFor(kept))[0]?.output).toMatchObject({ recorded: true });
    // the agent is told, to say in its own words; nothing is posted
    await expect
      .poll(() => notes.some((n) => n.includes('recorded') && n.includes(kept)), {
        timeout: 10_000,
      })
      .toBe(true);
    // named twice is refused by name, and nothing is recorded again
    const twice = await api(admin, 'POST', NAMED(), {
      source: 'rocketchat',
      externalId: OWNER_ID,
      userId: w.ownerId,
      reason: 'again',
    });
    expect(refusalOf(twice.body)?.code, JSON.stringify(twice.body)).toBe('SPEAKER_ALREADY_LINKED');
    expect(await answeredEvents(kept)).toBe(1);
  });

  it('records the named owner’s next answer directly, as him', async () => {
    const id = await parked('Show token usage on the pricing page?');
    const { out } = await ownerAnswers(id, 'Dùng giá công bố của từng model, và hiện token usage');
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect((await question(id))?.steps.at(-1)).toMatchObject({ answeredBy: w.ownerId });
    expect(await keptFor(id)).toEqual([]);
  });

  it('resolves only in the project whose admin named it', async () => {
    const { resolveSpeaker } = await import('../../src/assistant/index.js');
    const { namespaceFromServerUrl } = await import(
      '../../src/integrations/rocketchat/namespace.js'
    );
    const ref = {
      source: 'rocketchat',
      namespace: namespaceFromServerUrl(chat.serverUrl) ?? '',
      externalId: OWNER_ID,
    };
    expect(await resolveSpeaker(ref, w.projectId)).toMatchObject({
      linked: true,
      userId: w.ownerId,
    });
    expect(await resolveSpeaker(ref, w.home)).toMatchObject({ linked: false });
    expect(await resolveSpeaker(ref)).toMatchObject({ linked: false });
  });

  it('is undone by an admin, the record kept with who and why, and his answer is kept again', async () => {
    const listed = await api(admin, 'GET', NAMED());
    expect(listed.status).toBe(200);
    const namings = (listed.body as { namings: { id: string; externalId: string }[] }).namings;
    const naming = namings.find((n) => n.externalId === OWNER_ID);
    expect(naming).toBeTruthy();
    const byMember = await api(member, 'DELETE', `${NAMED()}/${naming?.id}`, { reason: 'x' });
    expect(byMember.status).toBe(403);
    const undone = await api(admin, 'DELETE', `${NAMED()}/${naming?.id}`, {
      reason: 'named the wrong account',
    });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [row] = await rows<Record<string, unknown>>(sql`
      SELECT undone_by, undo_reason, undone_at FROM speaker_link_namings WHERE id = ${naming?.id}::uuid`);
    expect(row).toMatchObject({ undone_by: adminId, undo_reason: 'named the wrong account' });
    expect(row?.undone_at).toBeTruthy();
    const again = await api(admin, 'DELETE', `${NAMED()}/${naming?.id}`, { reason: 'again' });
    expect(refusalOf(again.body)?.code, JSON.stringify(again.body)).toBe('SPEAKER_NAMING_UNDONE');

    const id = await parked('Keep the old price table?');
    const { out } = await ownerAnswers(id, 'Giữ lại');
    expect(code(out)).toBe('SUPPORT_ANSWER_NOT_THE_OWNER');
    expect(await keptFor(id)).toHaveLength(1);
  });
});
