// REQ-41 BC-1, BC-2 (probe of 2026-10-09: 28 requirements were marked as the owner's, about 6 needed
// them). The needs-me read answers "what waits on me" with only the decisions a person must make,
// each with its question, a recommended answer and buttons that post to the record's own route, and
// counts every other Needs you row under the reason it is not a decision. Driven through the real
// app on a throwaway Postgres: the route, the buttons pressed as the viewer, the device ask door.
// @direct-test-of packages/core/src/lib/standing-times.ts
// @direct-test-of packages/core/src/development/needs-you-decisions.ts

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
  makeAgreeReady,
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

/** A spec answering the ready checklist's problem, value, measure and persona: REQ-1's revision 2 is accepted on an agreed requirement, which judges it. */
const READY_SPEC = {
  goal: 'Problem: a referral is lost.\nValue: every referral reaches a clinician.\nMeasured by: lost referrals per month.',
  personas: ['Referral manager'],
};

const byKey = (all: readonly NeedsYouDecision[], key: string) => all.find((d) => d.key === key);

async function seedRequirement(
  seq: number,
  owner: string,
  revisions: { n: number; state: string; author: string }[],
) {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const id = randomUUID();
  const current = revisions.find((r) => r.state === 'current')?.n ?? null;
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status, owner_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`requirement ${seq}`}, 'draft', ${owner})
    `);
    for (const r of revisions) {
      await tx.execute(sql`
        INSERT INTO requirement_revisions
          (requirement_id, revision, base_revision, state, spec, reason, author_id, author_agency, proposed_at, decided_by, decided_at)
        VALUES (${id}, ${r.n}, ${r.n > 1 ? r.n - 1 : null}, ${r.state}, ${JSON.stringify(READY_SPEC)}::jsonb, 'written for the test', ${r.author}, 'human',
                ${r.state === 'draft' ? null : new Date().toISOString()},
                ${r.state === 'current' ? r.author : null}, ${r.state === 'current' ? new Date().toISOString() : null})
      `);
    }
    // one business criterion from its first revision on: what the ready checklist asks it to state
    if (revisions.length > 0) {
      await tx.execute(sql`
        INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
        VALUES (${id}, 'BC-1', 'it holds', 1)
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
  // the owner's requirement, whose revision 2 another member proposed: with approvals.revisions off
  // (the default) its accept is asked of the requirement's owner alone (REQ-34 BC-22)
  await seedRequirement(1, ownerId, [
    { n: 1, state: 'current', author: ownerId },
    { n: 2, state: 'proposed', author: authorId },
  ]);
  // its proposed revision 2 links a workflow design, the last answer the accept's ready checklist reads
  await makeAgreeReady(projectId, 1, ownerId);
  // the owner's own draft: their work to finish, not a decision
  await seedRequirement(2, ownerId, [{ n: 1, state: 'draft', author: ownerId }]);
  // the owner's drafts with no current revision: one never written, one whose only draft was
  // withdrawn. An agree pins a current head, so neither has anything to agree (REQ-48 BC-11)
  await seedRequirement(3, ownerId, []);
  const withdrawn = await seedRequirement(4, ownerId, [{ n: 1, state: 'draft', author: ownerId }]);
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      UPDATE requirement_revisions SET state = 'withdrawn', withdrawn_reason = 'dropped for the test',
        withdrawn_at = now(), withdrawn_by = ${ownerId}
      WHERE revision = 1 AND requirement_id = (SELECT id FROM requirements
        WHERE project_id = ${projectId} AND req_seq = ${Number(withdrawn.slice(4))})
    `),
  );
}, 120_000);

afterAll(closeWorld);

describe('GET /api/projects/:id/needs-you/decisions (REQ-41 BC-1)', () => {
  it('answers only the decisions a person must make, and counts the rest by reason', async () => {
    const r = await read();
    expect(r.decisions.map((d) => d.key).sort()).toEqual(
      ['ISS-1', 'ISS-2', 'ISS-3', 'REQ-1', ids.detached].sort(),
    );
    expect(r.total).toBe(5);
    // the owner's own draft and the draft issue nobody took on are no person's decision, so their
    // slices never group them needs_you (REQ-48 BC-11, `lib/standing-times.ts:withTimes`): neither
    // reaches Needs you, so neither is counted as left out of it
    expect(r.notDecisions).toEqual([]);
    // the Needs you read lists exactly what the needs-me read answers: nothing is dropped in silence
    const needs = await api(token, 'GET', `/api/projects/${projectId}/needs-you`);
    const asks = (needs.body.items as { key: string; space: string }[]).filter(
      (i) => i.space === 'asks',
    );
    expect(asks.map((i) => i.key)).not.toContain('REQ-2');
    expect(asks.map((i) => i.key)).not.toContain('ISS-4');
    // a draft with no current revision is its owner's to write, never "agree it": both reads say so
    // (REQ-48 BC-11; it read "agree it" here while the decisions read classed it as work)
    for (const key of ['REQ-3', 'REQ-4']) {
      expect(asks.map((i) => i.key)).not.toContain(key);
      expect(byKey(r.decisions, key)).toBeUndefined();
    }
    // what the agent takes is the master's, listed on neither read (REQ-68 BC-3)
    const counted =
      r.total +
      r.notDecisions.filter((x) => x.reason !== 'agent_takes').reduce((n, x) => n + x.count, 0);
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
    expect(d?.noRecommendation).toContain('The run that asked gave no recommended answer');
  });

  // an accept is a sign-off and records why (REQ-4 BC-16): its button carries the recommendation's why
  it('a proposed revision: accept recommended by rule with its why as the reason, return asks one', async () => {
    const d = byKey((await read()).decisions, 'REQ-1');
    expect(d).toMatchObject({ group: 'approve', recommended: { answerId: 'accept', by: 'rule' } });
    expect(d?.answers[0]?.body).toEqual({ reason: d?.recommended?.why });
    expect(d?.answers.map((a) => [a.act, a.path, a.needsReason])).toEqual([
      ['revision.accept', `/api/projects/${projectId}/requirements/REQ-1/revisions/2/accept`, true],
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
    // the accept pressed as offered recorded the recommendation's why as its reason (REQ-4 BC-16)
    const [accepted] = await rows<{ accept_reason: string | null }>(sql`
      SELECT v.accept_reason FROM requirement_revisions v JOIN requirements r ON r.id = v.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = 1 AND v.revision = 2`);
    expect(accepted?.accept_reason).toBe(byKey(before.decisions, 'REQ-1')?.recommended?.why);
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
