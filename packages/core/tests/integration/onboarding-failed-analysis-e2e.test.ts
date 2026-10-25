/**
 * ISS-605 (REQ-10 BC-11): an onboarding whose last analysis job failed after its retries never reads
 * done. Forge's own onboarding read `done` with no hint while its revise job 1779f21f had failed ten
 * attempts with `cc-startup-death` (judge K10 on 0.4.0-dev.268), so nobody was told the round-2
 * answers may never have reached the designs. Here the real routes read that shape: the failure is
 * shown, it names who acts and what they do, and it waits on no answer — an unanswered question stays
 * open on its own item. Who acts reads as the role that holds onboarding.request, and You to a reader
 * who holds it; the runner's failure tag stays off the line (ISS-605 round 2, judge K71).
 *
 * @direct-test-of packages/core/src/onboarding/read.ts
 * @direct-test-of packages/core/src/onboarding/hint.ts
 * @direct-test-of packages/core/src/onboarding/rules.ts
 * @direct-test-of packages/core/src/onboarding/routes.ts
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
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Who = 'owner' | 'master' | 'viewer';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
/** Forge's shape: done on its assumptions, then the revise job after a partial answer fails. */
let doneProject = '';
/** Not yet done: the analyse job fails while a round still holds a question open. */
let openProject = '';
let doneRoom = '';
let openRoom = '';

const at = (project: string, path: string) => `/api/projects/${project}${path}`;
const state = async (project: string, as: Who = 'owner') =>
  ok(await say(as, 'GET', at(project, '/onboarding')));
const roomStatus = async (room: string) =>
  ok(await say('owner', 'GET', `/api/conversations/${room}`)).threadStatus as string;

const choice = (id: string, group: 'question' | 'assumption'): Doc => ({
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
});
const round = (items: Doc[]) => ({ title: 'What the code cannot answer', items });

async function proposedDesign(project: string): Promise<string> {
  const doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  doc.project = project;
  doc.flow = 'post-discharge';
  const made = ok(
    await say('master', 'POST', at(project, '/workflows'), { baseRevision: null, document: doc }),
    201,
  );
  const id = made.document.id as string;
  ok(await say('master', 'POST', at(project, `/workflows/${id}/design/propose`), { revision: 1 }));
  return id;
}

async function kernel(statement: ReturnType<typeof sql>) {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) => tx.execute(statement));
}

const lastJobOf = async (project: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT last_job_id AS id FROM onboardings WHERE project_id = ${project}`,
    )
  )[0]?.id as string;

/** The newest attempt of the chain core retries from `first`. */
async function newestAttempt(first: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, 1 AS n FROM jobs WHERE id = ${first}
      UNION ALL SELECT j.id, c.n + 1 FROM jobs j JOIN chain c ON j.retry_of = c.id
    ) SELECT id FROM chain ORDER BY n DESC LIMIT 1`);
  return row?.id as string;
}

/** Ends the newest attempt failed and queues core's next one, as `scheduleAutoRetryWithVerify` does. */
async function failAndRetry(first: string, reason: string) {
  const newest = await newestAttempt(first);
  await kernel(sql`
    UPDATE jobs SET status = 'failed', finished_at = now(), failure_reason = ${reason}
    WHERE id = ${newest}`);
  await kernel(sql`
    INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, payload, status, attempts, retry_of)
    SELECT project_id, issue_id, pipeline_run_id, created_by, type, payload, 'queued', attempts + 1, id
    FROM jobs WHERE id = ${newest}`);
}

/** Ends the newest attempt failed with no retry after it: the budget is spent. */
async function failForGood(first: string, reason: string) {
  await kernel(sql`
    UPDATE jobs SET status = 'failed', finished_at = now(), failure_reason = ${reason}
    WHERE id = ${await newestAttempt(first)}`);
}

/** Brings the project's last job to forge's shape, whatever ran before: attempt 10 failed, nothing after it. */
async function failedAtTen(project: string) {
  const first = await lastJobOf(project);
  const newest = async () =>
    (
      await rows<{ attempts: number; status: string }>(
        sql`SELECT attempts, status FROM jobs WHERE id = ${await newestAttempt(first)}`,
      )
    )[0];
  while (Number((await newest())?.attempts) < 10) await failAndRetry(first, 'cc-startup-death');
  if ((await newest())?.status !== 'failed') await failForGood(first, 'cc-startup-death');
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  doneProject = (await createTestProject(ownerId)).id;
  openProject = (await createTestProject(ownerId)).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  const viewerId = (await createTestUser({ verified: true })).id;
  for (const p of [doneProject, openProject]) {
    await seedProjectDocument(p, ownerId, { environments: {}, source: { type: 'none' } });
    await addProjectMember(p, agentId, 'admin');
    await addProjectMember(p, viewerId, 'viewer');
  }
  say = requester(app, {
    owner: await signUserToken(ownerId),
    viewer: await signUserToken(viewerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [doneProject, openProject],
      })
    ).plaintext,
  });

  // forge's shape: analysed, done on its assumptions, then a partial answer queues the revise job
  doneRoom = ok(await say('owner', 'POST', at(doneProject, '/onboarding/start'), {}), 201)
    .onboarding.conversationId;
  const design = await proposedDesign(doneProject);
  ok(
    await say('master', 'POST', at(doneProject, '/onboarding/updates'), {
      text: 'Read the code.',
      designs: { heading: 'Designs drafted', workflowIds: [design] },
    }),
  );
  const batch = ok(
    await say(
      'master',
      'POST',
      at(doneProject, '/onboarding/questionnaires'),
      round([choice('q1', 'question'), choice('q2', 'question'), choice('a1', 'assumption')]),
    ),
    201,
  ).questionnaire as Doc;
  ok(await say('master', 'POST', at(doneProject, '/onboarding/done'), {}));
  await kernel(
    sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE project_id = ${doneProject}`,
  );
  ok(
    await say('owner', 'POST', at(doneProject, `/questionnaires/${batch.id}/answers`), {
      answers: [{ itemId: 'q1', choice: 'no' }],
    }),
  );

  // not yet done: the analyse job runs while a round holds a question open
  openRoom = ok(await say('owner', 'POST', at(openProject, '/onboarding/start'), {}), 201)
    .onboarding.conversationId;
  ok(
    await say(
      'master',
      'POST',
      at(openProject, '/onboarding/questionnaires'),
      round([choice('q1', 'question')]),
    ),
    201,
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('c1: a failed analysis never reads done, and says it failed', () => {
  it('reads done while the revise job is retried: a retry still pending is not a failure', async () => {
    const first = await lastJobOf(doneProject);
    for (let i = 0; i < 9; i++) await failAndRetry(first, 'cc-startup-death');
    const s = await state(doneProject);
    expect(s.onboarding.status).toBe('done');
    expect(s.onboarding.job).toMatchObject({ phase: 'revise', status: 'queued', attempt: 10 });
    expect(await roomStatus(doneRoom)).toBe('done');
  });

  it('reads failed once the tenth attempt failed with nothing after it, on the read, the hint and the room', async () => {
    await failForGood(await lastJobOf(doneProject), 'cc-startup-death');
    const s = await state(doneProject);
    expect(s.onboarding.status).toBe('failed');
    expect(s.onboarding.doneAt).not.toBeNull();
    expect(s.onboarding.job).toMatchObject({
      phase: 'revise',
      status: 'failed',
      attempt: 10,
      endedWith: 'cc-startup-death',
    });
    expect(s.hint).not.toBeNull();
    expect(s.hint.tone).toBe('err');
    expect(s.hint.says.lead.key).toBe('onboarding.hint.failed');
    expect(s.hint.text).toContain('Attempt 10 failed');
    // the runner's failure tag is agent text: the view carries it for the Developer view, never the line
    expect(s.hint.text).not.toContain('cc-startup-death');
    expect(await roomStatus(doneRoom)).toBe('failed');
  });
});

describe('c2: the failed state names who acts and what they do', () => {
  // its probe runs it alone (-t c2), so it brings its own failure rather than c1's
  beforeAll(() => failedAtTen(doneProject));

  it('names You to a person holding onboarding.request, whose act is a re-analysis', async () => {
    const { hint } = await state(doneProject, 'owner');
    expect(hint.says.text.vars.who).toEqual({ key: 'standing.who.you' });
    expect(hint.text).toBe('Attempt 10 failed · Waits on: You');
    expect(hint).toMatchObject({
      action: 'reanalyze',
      actionLabel: 'Ask for a re-analysis',
      mayReanalyze: true,
    });
  });

  it('names the role holding onboarding.request to a reader who does not hold it, never the permission id', async () => {
    const { hint } = await state(doneProject, 'viewer');
    expect(hint.says.text.vars.who).toEqual({
      key: 'standing.who.holderOf',
      vars: { perm: 'onboarding.request' },
    });
    expect(hint.text).toBe('Attempt 10 failed · Waits on: Member');
    expect(hint.text).not.toContain('onboarding.request');
    expect(hint).toMatchObject({ action: 'reanalyze', mayReanalyze: false });
    const r = await say('viewer', 'POST', at(doneProject, '/onboarding/reanalyze'), {});
    expect(r.status).toBe(403);
    expect((await state(doneProject)).onboarding.status).toBe('failed');
  });

  it('names You to the master too: it holds onboarding.request, so it is offered the act (REQ-72 BC-4)', async () => {
    const { hint } = await state(doneProject, 'master');
    expect(hint.says.text.vars.who).toEqual({ key: 'standing.who.you' });
    expect(hint.text).toBe('Attempt 10 failed · Waits on: You');
    expect(hint.mayReanalyze).toBe(true);
  });

  it('runs the re-analysis an agent holding onboarding.request asks for, as a person’s (REQ-72 BC-4)', async () => {
    const r = await say('master', 'POST', at(doneProject, '/onboarding/reanalyze'), {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await state(doneProject)).onboarding.status).not.toBe('failed');
  });
});

describe('c3: a failed analysis waits on no answer; an open question stays open on its own item', () => {
  it('reads failed, not waiting on you, while a round still holds a question open', async () => {
    const before = await state(openProject);
    expect(before.onboarding.status).toBe('waiting_on_you');
    await failForGood(await lastJobOf(openProject), 'cc-startup-death');
    const s = await state(openProject);
    expect(s.onboarding.status).toBe('failed');
    expect(s.onboarding.openBatch).toMatchObject({ open: 1 });
    expect(s.hint.action).toBe('reanalyze');
    expect(s.hint.says.text.vars.who.key).toBe('standing.who.you');
    expect(await roomStatus(openRoom)).toBe('failed');
  });

  it('leaves the unanswered question open on its item on the done onboarding', async () => {
    const answers = ok(await say('owner', 'GET', at(doneProject, '/onboarding/answers')));
    const items = (answers.questionnaires as Doc[]).at(-1)?.items as Doc[];
    expect(items.find((i) => i.id === 'q2')).toMatchObject({ state: 'open', answer: null });
    expect(items.find((i) => i.id === 'q1')).toMatchObject({ state: 'answered' });
  });

  it('lifts the failure once a person asks for a re-analysis: a live job reads in progress', async () => {
    ok(await say('owner', 'POST', at(openProject, '/onboarding/reanalyze'), {}));
    const s = await state(openProject);
    expect(s.onboarding.status).toBe('in_progress');
    expect(s.onboarding.job).toMatchObject({ phase: 'analyse', status: 'queued', attempt: 1 });
    expect(await roomStatus(openRoom)).toBe('in_progress');
  });
});
