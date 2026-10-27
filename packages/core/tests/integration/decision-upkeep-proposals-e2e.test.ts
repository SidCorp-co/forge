// REQ-68 BC-8, judged red on 0.4.0-dev.325 (K98): on day 14 the agent proposed a defer or a drop only
// for a question asked of a requirement. Steward decisions 15 days old on an issue planned against a
// requirement (ISS-933), on an issue with none (ISS-934) and about a feedback item (FB-936) were never
// escalated, and a decision that is no question (a sign-off, a proposal) was never even reminded.
// - A round on an issue planned against a requirement proposes deferring that requirement.
// - A round holding up no requirement proposes its own drop, recommended with why and its reason
//   prefilled, so it is one press.
// - A decision that is no question is reminded on day 3 and its decline proposed on day 14, once each.
//
// @direct-test-of packages/core/src/questions/decision-age.ts
// @direct-test-of packages/core/src/steward/decision-upkeep.ts
// @direct-test-of packages/core/src/development/needs-you-escalation.ts
// @direct-test-of packages/core/src/development/needs-you-aged.ts
// @direct-test-of packages/core/src/development/needs-you-decisions-read.ts

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
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let say: (who: 'owner' | 'member', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let ask: typeof import('../../src/questions/index.js').askQuestion;
let upkeep: typeof import('../../src/steward/index.js').sweepDecisionUpkeep;
let aged: typeof import('../../src/development/index.js').sweepAgedDecisions;
let readDecisions: typeof import('../../src/development/index.js').readNeedsYouDecisions;
let accessOf: typeof import('../../src/lib/authz.js').loadProjectAccess;
const DAY = 86_400_000;

const decisionsNow = async (now?: Date) =>
  readDecisions(
    projectId,
    { userId: ownerId, agency: 'human', isAdmin: true, mayApprove: true, mayWrite: true },
    await accessOf(projectId, ownerId),
    now,
  );

const option = (id: string, label: string) => ({
  id,
  label,
  authority: 'writer' as const,
  bindsTo: 'this_call' as const,
  executedBy: 'core' as const,
  fingerprint: 'decision-upkeep',
});

/** A steward decision (keep or drop) on an item, as the steward's door writes one, asked `days` ago. */
async function stewardDecision(anchor: Record<string, unknown>, days: number): Promise<string> {
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
  await rows(sql`UPDATE agent_questions
    SET steps = jsonb_set(steps, ARRAY[(jsonb_array_length(steps) - 1)::text, 'askedAt'],
                          to_jsonb(${new Date(Date.now() - days * DAY).toISOString()}::text)),
        created_at = now() - make_interval(days => ${days})
    WHERE id = ${id} RETURNING id`);
  return id;
}

const escalatedAt = async (id: string) =>
  (
    await rows<{ escalated_at: string | null }>(sql`
    SELECT escalated_at FROM agent_questions WHERE id = ${id}`)
  )[0]?.escalated_at ?? null;

const told = (title: string) =>
  rows<{ id: string }>(sql`SELECT id FROM notifications
    WHERE project_id = ${projectId} AND type = 'decision_reminder' AND title LIKE ${`${title}%`}`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ({ askQuestion: ask } = await import('../../src/questions/index.js'));
  ({ sweepDecisionUpkeep: upkeep } = await import('../../src/steward/index.js'));
  ({ sweepAgedDecisions: aged, readNeedsYouDecisions: readDecisions } = await import(
    '../../src/development/index.js'
  ));
  ({ loadProjectAccess: accessOf } = await import('../../src/lib/authz.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  const memberId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, memberId, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(memberId),
  });
}, 120_000);

afterAll(closeWorld);

describe('on day 14 the agent proposes a defer or a decline for every decision (REQ-68 BC-8)', () => {
  it('a steward decision on an issue planned against a requirement proposes deferring the requirement (ISS-933)', async () => {
    const req = await createTestRequirement(projectId, 933, 'Exports keep every column');
    const issue = await createTestIssue(projectId, ownerId, 933, {
      status: 'open',
      createdAt: new Date(),
    });
    await rows(
      sql`UPDATE issues SET requirement_id = ${req.id} WHERE id = ${issue.id} RETURNING id`,
    );
    const q = await stewardDecision({ issueId: issue.id }, 15);
    await upkeep();
    expect(await escalatedAt(q)).not.toBeNull();
    expect(await told(`${req.key}: defer or drop proposed`)).toHaveLength(1);
    const d = (await decisionsNow()).decisions.find((x) => x.key === issue.key);
    expect(d?.recommended).toMatchObject({ answerId: 'escalation.defer', by: 'rule' });
    expect(d?.answers[0]).toMatchObject({
      act: 'requirement.defer',
      path: expect.stringContaining(`/requirements/${req.key}/defer`),
    });
  });

  it.each([
    ['an issue with no requirement (ISS-934)', 'ISS-934'],
    ['a feedback item (FB-936)', 'FB-936'],
  ])('a steward decision on %s proposes its own drop, its why prefilled', async (_what, key) => {
    const anchor =
      key === 'ISS-934'
        ? {
            issueId: (
              await createTestIssue(projectId, ownerId, 934, {
                status: 'open',
                createdAt: new Date(),
              })
            ).id,
          }
        : {
            about: {
              kind: 'feedback',
              feedbackId: await (async () => {
                await createTestFeedback(projectId, ownerId, 936);
                const [fb] = await rows<{ id: string }>(sql`
                  SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = 936`);
                return fb?.id;
              })(),
            },
          };
    const q = await stewardDecision(anchor, 15);
    await upkeep();
    expect(await escalatedAt(q)).not.toBeNull();
    expect(await told(`${key}: dropping it is proposed`)).toHaveLength(1);
    const d = (await decisionsNow()).decisions.find((x) => x.id === `question:${q}`);
    expect(d?.recommended).toMatchObject({ answerId: 'steward.drop', by: 'rule' });
    expect(d?.recommended?.why).toContain('No answer in 14 days');
    expect(d?.answers[0]).toMatchObject({ id: 'steward.drop', recommended: true });
    // one press: the drop's reason is the proposal's why (REQ-68 BC-2)
    expect(d?.answers[0]?.body).toMatchObject({
      optionId: 'steward.drop',
      note: expect.stringContaining('No answer in 14 days'),
    });
    // a second pass proposes nothing twice
    await upkeep();
    expect(await told(`${key}: dropping it is proposed`)).toHaveLength(1);
  });

  it('a decision that is no question is reminded on day 3 and its decline proposed on day 14, once each', async () => {
    const issue = await createTestIssue(projectId, ownerId, 940, {
      status: 'open',
      createdAt: new Date(),
    });
    ok(
      await say('member', 'POST', `/api/projects/${projectId}/mockups`, {
        target: { issue: issue.key },
        kind: 'html',
        name: 'export.html',
        mime: 'text/html',
        caption: 'the export page as it should look',
        contentBase64: Buffer.from('<p>export</p>').toString('base64'),
      }),
      201,
    );
    const mockup = () =>
      decisionsNow().then((r) => r.decisions.find((x) => x.title === 'export.html'));
    expect((await mockup())?.recommended?.why ?? '').not.toContain('No answer in');

    await rows(
      sql`UPDATE mockups SET created_at = now() - interval '4 days' WHERE name = 'export.html' RETURNING id`,
    );
    await aged(new Date(), [projectId]);
    await aged(new Date(), [projectId]);
    expect(await told(`${issue.key}: a decision has waited 3 days`)).toHaveLength(1);
    expect(await told(`${issue.key}: "`)).toHaveLength(0);

    await rows(
      sql`UPDATE mockups SET created_at = now() - interval '15 days' WHERE name = 'export.html' RETURNING id`,
    );
    const d = await mockup();
    const decline = d?.answers.find((a) => a.declines);
    expect(d?.recommended).toMatchObject({ answerId: decline?.id, by: 'rule' });
    expect(d?.recommended?.why).toContain('No answer in 14 days');
    await aged(new Date(), [projectId]);
    await aged(new Date(), [projectId]);
    expect(await told(`${issue.key}: "${decline?.label}" proposed after 14 days`)).toHaveLength(1);
  });
});
