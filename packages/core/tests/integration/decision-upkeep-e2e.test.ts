// REQ-68 BC-7 and BC-8, through the real doors and the real sweep.
//
// BC-7: a steward decision whose item moved leaves Needs you at once.
// - An issue move or a requirement move voids it inside the move's own transaction.
// - A feedback move hides it from the read at once, and the upkeep sweep voids it.
// - A person's question on the same item stays open.
//
// BC-8: an unanswered round reminds the people who owe it on day 3, once per round. On day 14 the
// agent proposes deferring or dropping the requirement it holds up: the decision leads with a defer,
// recommended and sent in one click, and a drop that asks its reason. A requirement that can be
// neither deferred nor dropped (a dropped one) gets no proposal and no stamp.
//
// @direct-test-of packages/core/src/questions/moved-decisions.ts
// @direct-test-of packages/core/src/questions/decision-age.ts
// @direct-test-of packages/core/src/steward/decision-upkeep.ts
// @direct-test-of packages/core/src/development/needs-you-escalation.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let ask: typeof import('../../src/questions/index.js').askQuestion;
let readOpen: typeof import('../../src/questions/index.js').readOpenPersonQuestions;
let sweepMoved: typeof import('../../src/questions/index.js').sweepMovedDecisions;
let upkeep: typeof import('../../src/steward/index.js').sweepDecisionUpkeep;
let readDecisions: typeof import('../../src/development/needs-you-decisions.js').readNeedsYouDecisions;
let accessOf: typeof import('../../src/lib/authz.js').loadProjectAccess;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const DAY = 86_400_000;

const viewer = () => ({
  userId: ownerId,
  agency: 'human' as const,
  isAdmin: true,
  mayApprove: true,
  mayWrite: true,
});
const decisionsNow = async () =>
  readDecisions(projectId, viewer(), await accessOf(projectId, ownerId));

const option = (id: string, label: string) => ({
  id,
  label,
  authority: 'writer' as const,
  bindsTo: 'this_call' as const,
  executedBy: 'core' as const,
  fingerprint: 'decision-upkeep',
});

/** A steward decision (keep or drop) on an item, as the steward's door writes one. */
async function stewardDecision(anchor: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await ask({
    id,
    projectId,
    ...anchor,
    prompt: 'Keep it or drop it?',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: [option('steward.keep', 'Keep it'), option('steward.drop', 'Drop it')],
      recommendedOptionId: 'steward.keep',
      why: 'it carries open feedback',
    },
  });
  return id;
}

/** A person's own free-text question on an item. */
async function personQuestion(anchor: Record<string, unknown>, prompt = 'Which roles?') {
  const id = randomUUID();
  await ask({
    id,
    projectId,
    ...anchor,
    prompt,
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the roles', recommended: 'Admins and clerks' },
  });
  return id;
}

const questionRow = async (id: string) =>
  (
    await rows<{
      status: string;
      ended_reason: string | null;
      void_reason: string | null;
      reminded_at: string | null;
      escalated_at: string | null;
    }>(sql`SELECT status, ended_reason, void_reason, reminded_at, escalated_at
      FROM agent_questions WHERE id = ${id}`)
  )[0];

/** Move the current round's ask back by `days`, as if it had waited that long. */
const agedBy = (id: string, days: number) =>
  rows(sql`UPDATE agent_questions
    SET steps = jsonb_set(steps, ARRAY[(jsonb_array_length(steps) - 1)::text, 'askedAt'],
                          to_jsonb(${new Date(Date.now() - days * DAY).toISOString()}::text)),
        created_at = now() - make_interval(days => ${days})
    WHERE id = ${id} RETURNING id`);

const feedbackIdOf = async (key: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(key.slice(3))}`,
    )
  )[0]?.id as string;

const remindersFor = (title: string) =>
  rows<{ id: string; title: string }>(sql`SELECT id, title FROM notifications
    WHERE project_id = ${projectId} AND type = 'decision_reminder' AND title LIKE ${`${title}%`}`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ({
    askQuestion: ask,
    readOpenPersonQuestions: readOpen,
    sweepMovedDecisions: sweepMoved,
  } = await import('../../src/questions/index.js'));
  ({ sweepDecisionUpkeep: upkeep } = await import('../../src/steward/index.js'));
  ({ readNeedsYouDecisions: readDecisions } = await import(
    '../../src/development/needs-you-decisions.js'
  ));
  ({ loadProjectAccess: accessOf } = await import('../../src/lib/authz.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(closeWorld);

describe('a decision whose item moved leaves at once (REQ-68 BC-7)', () => {
  it('an issue move voids its steward decision in the move, and a person question on it stays', async () => {
    const issue = await createTestIssue(projectId, ownerId, 701, {
      status: 'open',
      createdAt: new Date(),
    });
    const decision = await stewardDecision({ issueId: issue.id });
    const person = await personQuestion({ issueId: issue.id });
    ok(
      await say('owner', 'POST', `/api/issues/${issue.id}/transition`, {
        toStatus: 'on_hold',
        reason: 'waiting on the vendor',
      }),
    );
    expect(await questionRow(decision)).toMatchObject({
      status: 'void',
      ended_reason: 'item_moved',
      void_reason: expect.stringContaining('the issue moved from Open to On hold'),
    });
    expect((await questionRow(person))?.status).toBe('open');
  });

  it('a requirement move voids its steward decision in the move', async () => {
    const req = await createTestRequirement(projectId, 702, 'Exports keep every column');
    const decision = await stewardDecision({ requirementId: req.id });
    expect((await readOpen(projectId)).map((q) => q.id)).toContain(decision);
    ok(await say('owner', 'POST', at(`/requirements/${req.key}/defer`), { reason: 'next phase' }));
    expect(await questionRow(decision)).toMatchObject({
      status: 'void',
      ended_reason: 'item_moved',
      void_reason: expect.stringContaining('the requirement moved from draft to deferred'),
    });
    expect((await readOpen(projectId)).map((q) => q.id)).not.toContain(decision);
  });

  it('a feedback move hides its steward decision at once, and the sweep voids it', async () => {
    const fbId = await feedbackIdOf(await createTestFeedback(projectId, ownerId, 703));
    const decision = await stewardDecision({ about: { kind: 'feedback', feedbackId: fbId } });
    const person = await personQuestion({}, 'Which export?');
    expect((await readOpen(projectId)).map((q) => q.id)).toContain(decision);
    ok(
      await say('owner', 'POST', at('/feedback/FB-703/triage'), {
        route: 'decline',
        note: 'Not planned.',
      }),
    );
    // gone from the read before anything voids it
    expect((await questionRow(decision))?.status).toBe('open');
    const open = (await readOpen(projectId)).map((q) => q.id);
    expect(open).not.toContain(decision);
    expect(open).toContain(person);
    expect(await sweepMoved()).toContain(decision);
    expect(await questionRow(decision)).toMatchObject({
      status: 'void',
      ended_reason: 'item_moved',
      void_reason: expect.stringContaining('the feedback item moved'),
    });
    // a second pass finds nothing left to void
    expect(await sweepMoved()).not.toContain(decision);
  });

  it('refuses by name a decision about a feedback item named by key, and the Needs you read stays up', async () => {
    await createTestFeedback(projectId, ownerId, 705);
    for (const feedbackId of ['FB-705', randomUUID()]) {
      await expect(stewardDecision({ about: { feedbackId } })).rejects.toThrow(
        /QUESTION_ABOUT_UNKNOWN.*names no feedback item of this project/,
      );
    }
    const read = await decisionsNow();
    expect(read.decisions.length + read.notDecisions.length).toBeGreaterThan(0);
    expect(await readOpen(projectId)).toEqual(expect.any(Array));
  });

  it('a decision asked after the item moved stays', async () => {
    const fbId = await feedbackIdOf(await createTestFeedback(projectId, ownerId, 704));
    ok(
      await say('owner', 'POST', at('/feedback/FB-704/triage'), {
        route: 'decline',
        note: 'Not planned.',
      }),
    );
    const decision = await stewardDecision({ about: { kind: 'feedback', feedbackId: fbId } });
    expect((await readOpen(projectId)).map((q) => q.id)).toContain(decision);
    expect(await sweepMoved()).not.toContain(decision);
    expect((await questionRow(decision))?.status).toBe('open');
  });
});

describe('an unanswered decision is reminded, then escalated (REQ-68 BC-8)', () => {
  it('reminds the owner on day 3, once per round, and never a round 2 days old', async () => {
    const issue = await createTestIssue(projectId, ownerId, 711, {
      status: 'open',
      createdAt: new Date(),
    });
    const old = await personQuestion({ issueId: issue.id }, 'Which roles may export?');
    const young = await personQuestion({}, 'Which timezone?');
    await agedBy(old, 4);
    await agedBy(young, 2);
    await upkeep();
    expect((await questionRow(old))?.reminded_at).not.toBeNull();
    expect((await questionRow(young))?.reminded_at).toBeNull();
    const told = await remindersFor('ISS-711: a decision has waited 3 days');
    expect(told).toHaveLength(1);
    const recipients = await rows<{ user_id: string }>(sql`
      SELECT DISTINCT d.user_id FROM notification_delivery_members m
        JOIN notification_deliveries d ON d.id = m.delivery_id
      WHERE m.notification_id = ${told[0]?.id}`);
    expect(recipients.map((r) => r.user_id)).toEqual([ownerId]);
    await upkeep();
    expect(await remindersFor('ISS-711')).toHaveLength(1);
  });

  it('on day 14 proposes deferring the requirement: defer recommended with its reason prefilled, drop asks why', async () => {
    const req = await createTestRequirement(projectId, 712, 'Exports keep every column');
    const q = await personQuestion({ requirementId: req.id }, 'Which columns are required?');
    await agedBy(q, 15);
    const before = (await readOpen(projectId)).find((r) => r.id === q);
    expect(before?.escalated).toBeNull();
    await upkeep();
    expect((await questionRow(q))?.escalated_at).not.toBeNull();
    expect(await remindersFor('REQ-712: defer or drop proposed')).toHaveLength(1);
    expect((await readOpen(projectId)).find((r) => r.id === q)?.escalated).toEqual({
      key: 'REQ-712',
      status: 'draft',
    });
    const read = await decisionsNow();
    // the requirement's own question is a decision on it, listed in Needs you (REQ-68 BC-9)
    const decision = read.decisions.find((d) => d.key === 'REQ-712');
    expect(decision, JSON.stringify(read.decisions.map((d) => d.key))).toBeDefined();
    expect(decision?.recommended).toMatchObject({ answerId: 'escalation.defer', by: 'rule' });
    const [defer, drop] = decision?.answers ?? [];
    expect(defer).toMatchObject({
      id: 'escalation.defer',
      act: 'requirement.defer',
      path: `/api/projects/${projectId}/requirements/REQ-712/defer`,
      // the defer's rule asks a reason, prefilled from the recommendation (REQ-68 BC-2)
      needsReason: true,
      body: { reason: expect.stringContaining('No answer in 14 days') },
    });
    expect(drop).toMatchObject({ id: 'escalation.drop', declines: true, needsReason: true });
    // the round's own answer stays, so the person can still answer it
    expect(decision?.answers.some((a) => a.act === 'question.answer')).toBe(true);
    // pressing the defer as offered defers the requirement
    ok(await say('owner', 'POST', defer?.path as string, defer?.body));
    const [status] = await rows<{ status: string }>(
      sql`SELECT status FROM requirements WHERE id = ${req.id}`,
    );
    expect(status?.status).toBe('deferred');
  });

  it('proposes nothing for a requirement that can be neither deferred nor dropped', async () => {
    const req = await createTestRequirement(projectId, 713, 'Dropped already');
    ok(await say('owner', 'POST', at(`/requirements/${req.key}/drop`), { reason: 'not wanted' }));
    const q = await personQuestion({ requirementId: req.id }, 'Anything left?');
    await agedBy(q, 15);
    await upkeep();
    expect((await questionRow(q))?.escalated_at).toBeNull();
    expect(await remindersFor('REQ-713: defer')).toHaveLength(0);
  });
});
