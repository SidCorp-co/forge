// REQ-41 BC-1, BC-2 (probe of 2026-10-09: 28 requirements were marked as the owner's, about 6 needed
// them). The needs-me read answers "what waits on me" with only the decisions a person must make,
// each with its question, a recommended answer and buttons that post to the record's own route, and
// counts every other Needs you row under the reason it is not a decision. Driven through the real
// app on a throwaway Postgres: the route, the buttons pressed as the viewer, the device ask door.

import { randomUUID } from 'node:crypto';
import {
  type NeedsYouDecision,
  needsYouDecisionsSchema,
} from '@forge/contracts/needs-you-decisions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let authorId: string;
let token: string;
let ask: typeof import('../../src/questions/index.js').askQuestion;

const ids = {
  choice: randomUUID(),
  freeRecommended: randomUUID(),
  freeBare: randomUUID(),
  detached: randomUUID(),
};

const decisionsPath = () => `/api/projects/${projectId}/needs-you/decisions`;

async function read() {
  const res = await api(token, 'GET', decisionsPath());
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return needsYouDecisionsSchema.parse(res.body);
}

const byKey = (all: readonly NeedsYouDecision[], key: string) => all.find((d) => d.key === key);

async function seedRequirement(
  seq: number,
  revisions: { n: number; state: string; author: string }[],
) {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const id = randomUUID();
  const current = revisions.find((r) => r.state === 'current')?.n ?? null;
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      VALUES (${id}, ${projectId}, ${seq}, ${`requirement ${seq}`}, 'draft')
    `);
    for (const r of revisions) {
      await tx.execute(sql`
        INSERT INTO requirement_revisions
          (requirement_id, revision, base_revision, state, spec, reason, author_id, author_agency, proposed_at, decided_by, decided_at)
        VALUES (${id}, ${r.n}, ${r.n > 1 ? r.n - 1 : null}, ${r.state}, '{}'::jsonb, 'written for the test', ${r.author}, 'human',
                ${r.state === 'draft' ? null : new Date().toISOString()},
                ${r.state === 'current' ? r.author : null}, ${r.state === 'current' ? new Date().toISOString() : null})
      `);
    }
    if (current !== null) {
      await tx.execute(
        sql`UPDATE requirements SET current_revision = ${current}, status = 'agreed' WHERE id = ${id}`,
      );
    }
  });
  return `REQ-${seq}`;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ askQuestion: ask } = await import('../../src/questions/index.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  authorId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, authorId, 'member');
  token = await userToken(ownerId);
  const now = new Date();
  const issue = async (seq: number, status: string) =>
    createTestIssue(projectId, ownerId, seq, { status: status as never, createdAt: now });
  const choiceIssue = await issue(1, 'open');
  const freeIssue = await issue(2, 'open');
  const bareIssue = await issue(3, 'open');
  await issue(4, 'draft');
  const option = (id: string, label: string) => ({
    id,
    label,
    authority: 'writer' as const,
    bindsTo: 'session' as const,
    executedBy: 'agent' as const,
  });
  await ask({
    id: ids.choice,
    projectId,
    issueId: choiceIssue.id,
    prompt: 'Keep the old export format or move to the new one?',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: [option('keep', 'Keep the old format'), option('move', 'Move to the new one')],
      recommendedOptionId: 'move',
    },
  });
  await ask({
    id: ids.freeRecommended,
    projectId,
    issueId: freeIssue.id,
    prompt: 'Which staging URL should the run check?',
    blockerKind: 'human',
    answer: {
      shape: 'free_text',
      needed: 'the staging URL',
      recommended: 'https://staging.example.test',
    },
  });
  await ask({
    id: ids.freeBare,
    projectId,
    issueId: bareIssue.id,
    prompt: 'What is the customer account to reproduce with?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'an account id' },
  });
  await ask({
    id: ids.detached,
    projectId,
    prompt: 'Rotate the webhook secret now or at the next release?',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: [option('now', 'Now'), option('later', 'At the next release')],
      recommendedOptionId: 'later',
    },
  });
  // a revision another member proposed, which the owner signs off
  await seedRequirement(1, [
    { n: 1, state: 'current', author: authorId },
    { n: 2, state: 'proposed', author: authorId },
  ]);
  // the owner's own draft: their work to finish, not a decision
  await seedRequirement(2, [{ n: 1, state: 'draft', author: ownerId }]);
}, 120_000);

afterAll(closeWorld);

describe('GET /api/projects/:id/needs-you/decisions (REQ-41 BC-1)', () => {
  it('answers only the decisions a person must make, and counts the rest by reason', async () => {
    const r = await read();
    expect(r.decisions.map((d) => d.key).sort()).toEqual(
      ['ISS-1', 'ISS-2', 'ISS-3', 'REQ-1', ids.detached].sort(),
    );
    expect(r.total).toBe(5);
    const left = Object.fromEntries(r.notDecisions.map((n) => [n.reason, n.keys]));
    expect(left.own_work).toEqual(['REQ-2']);
    expect(left.awaiting_proposal).toEqual(['ISS-4']);
    // the Needs you read lists every one of them: nothing is dropped in silence
    const needs = await api(token, 'GET', `/api/projects/${projectId}/needs-you`);
    const asks = (needs.body.items as { key: string; space: string }[]).filter(
      (i) => i.space === 'asks',
    );
    const counted = r.total + r.notDecisions.reduce((n, x) => n + x.count, 0);
    expect(counted).toBe(asks.length);
  });

  it('refuses a reader outside the project', async () => {
    const stranger = (await createTestUser({ verified: true })).id;
    const res = await api(await userToken(stranger), 'GET', decisionsPath());
    expect([403, 404]).toContain(res.status);
  });
});

describe('each decision shows its question, a recommended answer and a button (REQ-41 BC-2)', () => {
  it('a choice question: every option a button, the asker’s recommended one marked', async () => {
    const d = byKey((await read()).decisions, 'ISS-1');
    expect(d).toMatchObject({
      group: 'answer',
      opens: { kind: 'issue', key: 'ISS-1' },
      question: 'Keep the old export format or move to the new one?',
      recommended: { answerId: 'move', by: 'asker' },
      noRecommendation: null,
    });
    expect(d?.answers.map((a) => [a.id, a.recommended, a.path])).toEqual([
      ['move', true, `/api/questions/${ids.choice}/answer`],
      ['keep', false, `/api/questions/${ids.choice}/answer`],
    ]);
  });

  it('a free-text question sends its recommended answer as it stands, or a typed one', async () => {
    const d = byKey((await read()).decisions, 'ISS-2');
    expect(d?.recommended?.answerId).toBe('recommended');
    expect(d?.answers[0]?.body).toEqual({ round: 1, text: 'https://staging.example.test' });
    expect(d?.answers[1]).toMatchObject({ id: 'write', needsReason: true });
  });

  it('a question asked with no recommendation says why there is none', async () => {
    const d = byKey((await read()).decisions, 'ISS-3');
    expect(d?.recommended).toBeNull();
    expect(d?.noRecommendation).toBe('The run that asked gave no recommended answer.');
  });

  it('a proposed revision: accept recommended by rule, return asks a reason', async () => {
    const d = byKey((await read()).decisions, 'REQ-1');
    expect(d).toMatchObject({ group: 'approve', recommended: { answerId: 'accept', by: 'rule' } });
    expect(d?.answers.map((a) => [a.act, a.path, a.needsReason])).toEqual([
      [
        'revision.accept',
        `/api/projects/${projectId}/requirements/REQ-1/revisions/2/accept`,
        false,
      ],
      ['revision.return', `/api/projects/${projectId}/requirements/REQ-1/revisions/2/return`, true],
    ]);
  });

  it('pressing each recommended button as the viewer is taken by its route, and the decision leaves', async () => {
    const before = await read();
    for (const key of ['ISS-1', 'ISS-2', ids.detached, 'REQ-1']) {
      const d = byKey(before.decisions, key);
      const a = d?.answers.find((x) => x.recommended);
      expect(a, `${key} has a recommended button`).toBeDefined();
      const res = await api(token, 'POST', a?.path ?? '', a?.body ?? {});
      expect(res.status, `${key}: ${JSON.stringify(res.body).slice(0, 300)}`).toBeLessThan(300);
    }
    const typed = byKey(before.decisions, 'ISS-3')?.answers[0];
    const res = await api(token, 'POST', typed?.path ?? '', { ...typed?.body, text: 'acct-778' });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
    const after = await read();
    expect(after.decisions).toEqual([]);
    expect(after.total).toBe(0);
  });
});

describe('a run asking a person a free-text question owes a recommended answer (REQ-41 BC-2)', () => {
  let boxToken: string;
  beforeAll(async () => {
    const deviceId = await createTestDevice(ownerId);
    await bindTestRunner(projectId, deviceId);
    const { mintPat } = await import('../../src/credentials/pat.js');
    const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
    boxToken = (
      await mintPat({
        userId: ownerId,
        name: deviceTokenNameFor(deviceId),
        permissions: ['*'],
        deviceId,
      })
    ).plaintext;
  });

  const body = (over: Record<string, unknown>) => ({
    id: randomUUID(),
    projectId,
    prompt: 'Which region does the backup go to?',
    answerShape: 'free_text',
    needed: 'a region name',
    ...over,
  });

  it('is refused QUESTION_RECOMMENDATION_REQUIRED, naming the field, and writes nothing', async () => {
    const sent = body({});
    const res = await api(boxToken, 'POST', '/api/devices/me/questions', sent);
    const error = res.body.error as { code: string; refusals: { code: string; path: string }[] };
    expect(res.status).toBe(422);
    expect(error.code).toBe('QUESTION_RECOMMENDATION_REQUIRED');
    expect(error.refusals[0]?.path).toBe('/recommended');
    expect(await rows(sql`SELECT id FROM agent_questions WHERE id = ${sent.id as string}`)).toEqual(
      [],
    );
  });

  it('is asked with one, and the recommended answer is stored on its round', async () => {
    const sent = body({ recommended: 'eu-west-1' });
    const res = await api(boxToken, 'POST', '/api/devices/me/questions', sent);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const [row] = await rows<{ steps: { recommended?: string }[] }>(
      sql`SELECT steps FROM agent_questions WHERE id = ${sent.id as string}`,
    );
    expect(row?.steps[0]?.recommended).toBe('eu-west-1');
  });
});
