/**
 * REQ-10 r4: onboarding drafts first, asks at most three questions and never waits. The catalog and
 * epod onboardings each put fifteen items to the person — the agent's own inferred answers and its
 * accept / reject recommendations among them — and sat unanswered from 2026-10-06 to 2026-10-21,
 * never finishing. Here the real routes hold the rule: what the code suggests is an assumption
 * recorded as answered, a round asks at most three recommended questions, a recommendation is a
 * suggestion on its own, and onboarding is done on its assumptions with a question still open.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Who = 'owner' | 'master';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let ownerId = '';
let agentId = '';
let projectId = '';
let oldProjectId = '';
let assumedProjectId = '';
let conversationId = '';
let design = '';

const at = (path: string, project = projectId) => `/api/projects/${project}${path}`;
const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code as string);
const refused = (r: Reply) => {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  return codesOf(r);
};

const choice = (id: string, group: string, extra: Doc = {}): Doc => ({
  id,
  group,
  control: 'choice',
  prompt: `Which reading holds for ${id}?`,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  inferredDefault: 'yes',
  why: 'The designs read differently on each answer.',
  evidence: ['apps/api/src/orders.ts:OrderStatus'],
  affects: ['post-discharge'],
  ...extra,
});
const question = (id: string, extra: Doc = {}) => choice(id, 'question', extra);
const assumption = (id: string, extra: Doc = {}) => choice(id, 'assumption', extra);
const round = (items: Doc[]) => ({ title: 'What the code cannot answer', items });

async function proposed(flow: string, propose = true): Promise<string> {
  const doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  doc.project = projectId;
  doc.flow = flow;
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: doc }),
    201,
  );
  const id = made.document.id as string;
  if (propose)
    ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  return id;
}

const batches = async () =>
  rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM questionnaire_batches WHERE project_id = ${projectId}`,
  ).then((r) => Number(r[0]?.n));
const onboarding = async (project = projectId) =>
  ok(await say('owner', 'GET', at('/onboarding', project))).onboarding as Doc;
const answers = async () =>
  (ok(await say('master', 'GET', at('/onboarding/answers'))).questionnaires as Doc[]).at(-1) as Doc;
const itemOf = (batch: Doc, id: string) => (batch.items as Doc[]).find((i) => i.id === id) as Doc;
const roomStatus = async () =>
  ok(await say('owner', 'GET', `/api/conversations/${conversationId}`)).threadStatus as string;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  oldProjectId = (await createTestProject(ownerId)).id;
  assumedProjectId = (await createTestProject(ownerId)).id;
  for (const p of [projectId, oldProjectId, assumedProjectId])
    await seedProjectDocument(p, ownerId, { environments: {}, source: { type: 'none' } });
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  await addProjectMember(oldProjectId, agentId, 'admin');
  await addProjectMember(assumedProjectId, agentId, 'admin');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [projectId, oldProjectId, assumedProjectId],
      })
    ).plaintext,
  });
  const started = await say('owner', 'POST', at('/onboarding/start'), {});
  expect([200, 201], JSON.stringify(started.json)).toContain(started.status);
  conversationId = started.json.onboarding.conversationId;
  design = await proposed('post-discharge');
  ok(
    await say('master', 'POST', at('/onboarding/updates'), {
      text: 'Read the code.',
      designs: { heading: 'Designs drafted', workflowIds: [design] },
    }),
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('BC-6: a round asks only what the code cannot answer, at most three questions', () => {
  it('refuses a fourth question by name, and writes no batch', async () => {
    const r = await say(
      'master',
      'POST',
      at('/onboarding/questionnaires'),
      round([question('q1'), question('q2'), question('q3'), question('q4'), assumption('a1')]),
    );
    expect(refused(r)).toEqual(['ONBOARDING_QUESTIONS_OVER_CAP']);
    expect(JSON.stringify(r.json)).toContain('at most 3 questions');
    expect(await batches()).toBe(0);
  });

  it('refuses a recommendation as an item, and a question with no recommended answer', async () => {
    const r = await say(
      'master',
      'POST',
      at('/onboarding/questionnaires'),
      round([
        {
          ...question('r1'),
          group: 'recommendation',
          control: 'accept_reject',
          options: undefined,
          inferredDefault: undefined,
        },
        question('q1', { inferredDefault: undefined }),
      ]),
    );
    expect(refused(r).sort()).toEqual([
      'ONBOARDING_QUESTION_UNRECOMMENDED',
      'ONBOARDING_RECOMMENDATION_IS_A_SUGGESTION',
    ]);
    expect(await batches()).toBe(0);
  });

  it('refuses an assumption that names no option the code suggests', async () => {
    const r = await say(
      'master',
      'POST',
      at('/onboarding/questionnaires'),
      round([assumption('a1', { inferredDefault: undefined })]),
    );
    expect(refused(r)).toEqual(['QUESTIONNAIRE_ITEM_INVALID']);
    expect(await batches()).toBe(0);
  });

  it('records each assumption as answered from the code, with its evidence, and never as an open question', async () => {
    const posted = ok(
      await say(
        'master',
        'POST',
        at('/onboarding/questionnaires'),
        round([question('q1'), question('q2'), assumption('a1'), assumption('a2')]),
      ),
      201,
    ).questionnaire as Doc;
    expect(posted.open).toBe(2);
    for (const id of ['a1', 'a2']) {
      expect(itemOf(posted, id)).toMatchObject({
        state: 'answered',
        answer: { choice: 'yes' },
        answeredBy: agentId,
        evidence: ['apps/api/src/orders.ts:OrderStatus'],
      });
    }
    expect(itemOf(posted, 'q1')).toMatchObject({ state: 'open', answer: null });
    const view = await onboarding();
    expect(view.openBatch.open).toBe(2);
    expect(view.status).toBe('waiting_on_you');
    expect(await roomStatus()).toBe('waiting_on_you');
  });
});

describe('BC-11: onboarding never waits on the person', () => {
  it('waits on nobody for a round of assumptions only, before it is done', async () => {
    const started = ok(
      await say('owner', 'POST', at('/onboarding/start', assumedProjectId), {}),
      201,
    );
    ok(
      await say(
        'master',
        'POST',
        at('/onboarding/questionnaires', assumedProjectId),
        round([assumption('a1'), assumption('a2')]),
      ),
      201,
    );
    const state = ok(await say('owner', 'GET', at('/onboarding', assumedProjectId)));
    expect(state.onboarding).toMatchObject({ status: 'in_progress', openBatch: { open: 0 } });
    expect(state.hint.action).not.toBe('continue');
    const room = ok(
      await say('owner', 'GET', `/api/conversations/${started.onboarding.conversationId}`),
    );
    expect(room.threadStatus).toBe('in_progress');
  });

  it('refuses the agent’s done while a design it registered stands at draft', async () => {
    const draft = await proposed('order-journey', false);
    ok(
      await say('master', 'POST', at('/onboarding/updates'), {
        text: 'One more design.',
        designs: { heading: 'Designs drafted', workflowIds: [draft] },
      }),
    );
    expect(refused(await say('master', 'POST', at('/onboarding/done'), {}))).toEqual([
      'ONBOARDING_DESIGNS_UNPROPOSED',
    ]);
    ok(await say('master', 'POST', at(`/workflows/${draft}/design/propose`), { revision: 1 }));
  });

  it('is done on its assumptions with both questions unanswered, and the room waits on nobody', async () => {
    const done = ok(await say('master', 'POST', at('/onboarding/done'), {})).onboarding as Doc;
    expect(done.status).toBe('done');
    expect(await roomStatus()).toBe('done');
    const d = (done.designs as Doc[]).find((x) => x.workflowId === design) as Doc;
    expect((d.openQuestions as Doc[]).map((q) => q.itemId).sort()).toEqual(['q1', 'q2']);
    expect(d.designStatus).toBe('proposed');
  });
});

describe('BC-7 and BC-8: one send, partial allowed, a changed assumption revised like an answer', () => {
  it('takes a partial answer and a changed assumption in one send; only the unanswered question stays open', async () => {
    const batch = await answers();
    const sent = ok(
      await say('owner', 'POST', at(`/questionnaires/${batch.id}/answers`), {
        answers: [
          { itemId: 'q1', choice: 'yes' },
          { itemId: 'a1', choice: 'no' },
        ],
      }),
    ).questionnaire as Doc;
    expect(itemOf(sent, 'q1')).toMatchObject({ state: 'answered', answeredBy: ownerId });
    expect(itemOf(sent, 'q2')).toMatchObject({ state: 'open', answer: null });
    expect(itemOf(sent, 'a1')).toMatchObject({ answer: { choice: 'no' }, answeredBy: ownerId });
    expect(itemOf(sent, 'a2')).toMatchObject({ answer: { choice: 'yes' }, answeredBy: agentId });
    expect(sent.open).toBe(1);
    expect((await onboarding()).status).toBe('done');
  });

  it('asks again only what stayed open, still at most three, on a done onboarding', async () => {
    expect(
      refused(
        await say(
          'master',
          'POST',
          at('/onboarding/questionnaires'),
          round([question('q2'), question('q5'), question('q6'), question('q7')]),
        ),
      ),
    ).toEqual(['ONBOARDING_QUESTIONS_OVER_CAP']);
    expect(
      refused(
        await say('master', 'POST', at('/onboarding/questionnaires'), round([question('q1')])),
      ),
    ).toEqual(['QUESTIONNAIRE_ITEM_ANSWERED_BEFORE']);
    const second = ok(
      await say('master', 'POST', at('/onboarding/questionnaires'), round([question('q2')])),
      201,
    ).questionnaire as Doc;
    expect(second).toMatchObject({ round: 2, open: 1 });
  });

  it('lands the changed assumption as a proposed revision that nothing makes current', async () => {
    // a revision written over a proposed design is proposed by the write itself
    const read = ok(await say('master', 'GET', at(`/workflows/${design}`)));
    ok(
      await say('master', 'PUT', at(`/workflows/${design}`), {
        baseRevision: read.revision,
        document: { ...read.document, summary: `${read.document.summary} The person said no.` },
      }),
    );
    ok(
      await say('master', 'POST', at('/onboarding/updates'), {
        text: 'The changed assumption is in revision 2.',
        designs: { heading: 'Updated designs', workflowIds: [design] },
        cites: [{ itemId: 'a1', workflowId: design, revision: 2 }],
      }),
    );
    const d = ((await onboarding()).designs as Doc[]).find((x) => x.workflowId === design) as Doc;
    expect(d).toMatchObject({ designStatus: 'proposed', revision: 2, approvedRevision: null });
    expect((d.linkedItems as Doc[]).find((i) => i.itemId === 'a1')?.citedRevision).toBe(2);
  });

  it('lets the agent end its phase on a done onboarding, and refuses any other second close', async () => {
    expect(refused(await say('owner', 'POST', at('/onboarding/done'), {}))).toEqual([
      'ONBOARDING_DONE',
    ]);
    ok(await say('master', 'POST', at('/onboarding/done'), { text: 'Revised.' }));
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE jobs SET status = 'cancelled' WHERE project_id = ${projectId}`),
    );
    expect(refused(await say('master', 'POST', at('/onboarding/done'), {}))).toEqual([
      'ONBOARDING_DONE',
    ]);
  });
});

describe('BC-8: a recommendation lands as a suggestion on its own', () => {
  it('is proposed with no accept on a card, and once rejected is not suggested again', async () => {
    const issue = await createTestIssue(projectId, ownerId, 801, {
      status: 'open',
      createdAt: new Date(),
    });
    const body = {
      kind: 'triage',
      issue: issue.key,
      baseRevision: null,
      payload: { note: 'The order retry belongs to the payments module.' },
    };
    const made = ok(await say('master', 'POST', at('/suggestions'), body), 201).suggestion as Doc;
    expect(made.status).toBe('proposed');
    ok(
      await say('owner', 'POST', at(`/suggestions/${made.id}/reject`), {
        reason: 'payments does not own retries',
      }),
    );
    const again = await say('master', 'POST', at('/suggestions'), body);
    expect(refused(again)).toEqual(['SUGGESTION_REJECTED_BEFORE']);
    expect(JSON.stringify(again.json)).toContain('payments does not own retries');
  });
});

describe('an open batch posted before r4 still reads and answers', () => {
  it('reads fifteen items with recommendations and inferred defaults, and takes an accept', async () => {
    ok(await say('owner', 'POST', at('/onboarding/start', oldProjectId), {}), 201);
    const { onboardingOf } = await import('../../src/onboarding/read.js');
    const { postQuestionnaireIn } = await import('../../src/questionnaires/service.js');
    const row = await onboardingOf(db, oldProjectId);
    if (!row) throw new Error('the old onboarding did not start');
    // the shared post path takes any item an earlier onboarding round took: it is the old batch, as written
    await db.transaction(async (tx) => {
      const posted = await postQuestionnaireIn(tx, {
        projectId: oldProjectId,
        conversationId: row.conversationId,
        onboardingId: row.id,
        requirementId: null,
        firstRequirementsOf: null,
        round: 1,
        seriesSince: row.startedAt,
        actor: { userId: agentId, agency: 'agent' },
        authorLabel: 'Agent',
        title: 'Round 1',
        items: [
          ...Array.from({ length: 13 }, (_, i) => question(`q${i}`)),
          {
            ...question('r1'),
            group: 'recommendation',
            control: 'accept_reject',
            options: undefined,
            inferredDefault: undefined,
          },
          { ...question('t1'), control: 'text', options: undefined, inferredDefault: undefined },
        ] as never,
      });
      expect(Array.isArray(posted), JSON.stringify(posted)).toBe(false);
    });
    const view = await onboarding(oldProjectId);
    expect(view).toMatchObject({ status: 'waiting_on_you', openBatch: { open: 15 } });
    const batch = (
      ok(await say('master', 'GET', at('/onboarding/answers', oldProjectId)))
        .questionnaires as Doc[]
    )[0] as Doc;
    expect(batch.items).toHaveLength(15);
    const sent = ok(
      await say('owner', 'POST', at(`/questionnaires/${batch.id}/answers`, oldProjectId), {
        answers: [{ itemId: 'r1', decision: 'accept' }],
      }),
    ).questionnaire as Doc;
    expect(itemOf(sent, 'r1')).toMatchObject({ state: 'answered', answer: { decision: 'accept' } });
  });
});
