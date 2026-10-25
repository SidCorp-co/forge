/**
 * REQ-10 BC-9 (ISS-603, FB-180): an answer sent to a batch a re-analysis replaced is refused
 * QUESTIONNAIRE_SUPERSEDED naming the batch that replaced it. Release judge K10 on 0.4.0-dev.268
 * followed the refusal's "Answer that one" to a replacement already answered and was refused
 * QUESTIONNAIRE_ALREADY_ANSWERED: the refusal named the next batch without reading its state. Here
 * the real routes walk the replacements to the batch that stands, through a chain of re-analyses,
 * and the refusal tells the person to answer it only while it still takes answers.
 */

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
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Who = 'owner' | 'master';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const batch: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

const at = (path: string) => `/api/projects/${projectId}${path}`;

const question = (id: string): Doc => ({
  id,
  group: 'question',
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

async function post(id: string): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/onboarding/questionnaires'), {
      title: 'What the code cannot answer',
      items: [question(id)],
    }),
    201,
  );
  return (made.questionnaire as Doc).id as string;
}

// the analysis job ends, so no live job refuses the ask for a re-analysis
async function reanalyze(): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(
      sql`UPDATE jobs SET status = 'done' WHERE project_id = ${projectId} AND type = 'onboarding'`,
    ),
  );
  ok(await say('owner', 'POST', at('/onboarding/reanalyze'), { reason: 'the code moved' }));
}

const answer = (id: string, itemId: string, body: Doc = {}) =>
  say('owner', 'POST', at(`/questionnaires/${id}/answers`), {
    answers: [{ itemId, choice: 'yes' }],
    ...body,
  });

/** The one refusal an answer drew: its code and detail. */
function refusalOf(r: Reply): { code: string; detail: string } {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const refusals = (r.json.error?.refusals ?? []) as Doc[];
  expect(refusals, JSON.stringify(r.json)).toHaveLength(1);
  return { code: refusals[0]?.code as string, detail: refusals[0]?.detail as string };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(ownerId);
  projectId = project.id;
  await seedProjectDocument(projectId, ownerId, { environments: {}, source: { type: 'none' } });
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  // a project's agent is its handle, so it carries one on its org membership, as a minted one does
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role, handle)
    VALUES (${project.orgId}, ${agentId}, 'member', 'onboarding-master')
  `);
  await addProjectMember(projectId, agentId, 'admin');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [projectId],
      })
    ).plaintext,
  });
  const started = await say('owner', 'POST', at('/onboarding/start'), {});
  expect([200, 201], JSON.stringify(started.json)).toContain(started.status);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('REQ-10 BC-9: an answer to a replaced batch is refused naming the batch that stands', () => {
  it('says no batch has replaced it yet while the re-analysis has posted none', async () => {
    batch.a = await post('qa');
    await reanalyze();
    const r = refusalOf(await answer(batch.a, 'qa'));
    expect(r.code).toBe('QUESTIONNAIRE_SUPERSEDED');
    expect(r.detail).toContain('no batch has replaced it yet');
    expect(r.detail).not.toMatch(/answer batch/i);
  });

  it('criterion 2: names the replacement as the one to answer while it is open', async () => {
    batch.b = await post('qb');
    const r = refusalOf(await answer(batch.a, 'qa'));
    expect(r.code).toBe('QUESTIONNAIRE_SUPERSEDED');
    expect(r.detail).toContain(`batch ${batch.b} replaced it`);
    expect(r.detail).toContain(`Answer batch ${batch.b} instead.`);
  });

  it('follows a chain of re-analyses to the batch that stands, and names it to answer', async () => {
    await reanalyze();
    batch.c = await post('qc');
    for (const old of [batch.a, batch.b]) {
      const r = refusalOf(await answer(old, old === batch.a ? 'qa' : 'qb'));
      expect(r.code).toBe('QUESTIONNAIRE_SUPERSEDED');
      expect(r.detail).toContain(`Answer batch ${batch.c} instead.`);
    }
    const fromA = refusalOf(await answer(batch.a, 'qa')).detail;
    expect(fromA).toContain(`batch ${batch.b} replaced it`);
    expect(fromA).toContain(`batch ${batch.c} replaced that`);
  });

  it('still names a replacement skipped for now, since a skipped batch takes answers', async () => {
    ok(await answer(batch.c, 'qc', { answers: [], skip: true }));
    const r = refusalOf(await answer(batch.a, 'qa'));
    expect(r.detail).toContain(`Answer batch ${batch.c} instead.`);
  });

  it('criterion 1: does not send the person to a replacement already answered', async () => {
    ok(await answer(batch.c, 'qc'));
    for (const [old, item] of [
      [batch.a, 'qa'],
      [batch.b, 'qb'],
    ] as const) {
      const r = refusalOf(await answer(old, item));
      expect(r.code).toBe('QUESTIONNAIRE_SUPERSEDED');
      expect(r.detail).not.toMatch(/answer that one/i);
      expect(r.detail).not.toMatch(/answer batch/i);
      expect(r.detail).toContain(`batch ${batch.c} was already answered`);
      expect(r.detail).toContain('What stayed open comes back in the next round');
    }
    // following the replacement is what the old wording sent the person to, and it is refused
    expect(refusalOf(await answer(batch.c, 'qc')).code).toBe('QUESTIONNAIRE_ALREADY_ANSWERED');
  });
});
