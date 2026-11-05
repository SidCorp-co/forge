// ISS-1006 round 2: a decision already pending when its asker was taught (0 of 32 on dev.513 carried
// plain text) gains its plain text without being asked again: `PUT /api/questions/:id/plain` sets
// `plain` on the open round. The asker writes it, as does the project's master (an agent's credential
// that writes the project) or a project admin; a person member who did not ask is refused naming the
// permission, a settled question QUESTION_NOT_OPEN, and a caller of another project is answered not
// found. Planted red by mounting no route, and by letting any member write.
//
// @direct-test-of packages/core/src/questions/plain-door.ts
// @direct-test-of packages/core/src/questions/routes.ts
// @direct-test-of packages/core/src/questions/read.ts
// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { askQuestion } from '../../src/questions/index.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

const PLAIN =
  'Customers get an Export CSV button on the orders page.\nSales waits on it for the weekly report.\nI recommend turning it on now.';

let projectId = '';
let ownerId = '';
let askerId = '';
const tok = { owner: '', asker: '', member: '', master: '', stranger: '' };

beforeAll(async () => {
  testEnv();
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'owner');
  askerId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, askerId, 'member');
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  const masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  const strangerId = (await createTestUser({ verified: true })).id;
  const elsewhere = (await createTestProject(strangerId)).id;
  await addProjectMember(elsewhere, strangerId, 'owner');
  const mint = async (userId: string, project: string, name: string) =>
    (await mintPat({ userId, name, projectIds: [project], permissions: ['*'] })).plaintext;
  tok.owner = await mint(ownerId, projectId, 'owner-cli');
  tok.asker = await mint(askerId, projectId, 'run-session');
  tok.member = await mint(memberId, projectId, 'member-cli');
  tok.master = await mint(masterId, projectId, 'master-box');
  tok.stranger = await mint(strangerId, elsewhere, 'stranger-cli');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** An open question a run asked a person, with no plain text: the shape every pending one had on dev.513. */
async function pending(): Promise<string> {
  const id = randomUUID();
  await askQuestion({
    id,
    projectId,
    askedBy: askerId,
    prompt: 'Turn the CSV export on now, or after the release?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'now or after the release', recommended: 'now' },
  });
  return id;
}

const write = (token: string, id: string, plain: unknown = PLAIN) =>
  api(token, 'PUT', `/api/questions/${id}/plain`, { plain });

const roundOf = async (id: string) =>
  (
    await rows<{ steps: Record<string, unknown>[] }>(
      sql`SELECT steps FROM agent_questions WHERE id = ${id}`,
    )
  )[0]?.steps.at(-1);

/** The open question's `plain` as the project's question list answers it to the master. */
const listedPlain = async (id: string) => {
  const read = await api(tok.master, 'GET', `/api/questions?projectId=${projectId}&status=open`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const q = (read.body.questions as Record<string, unknown>[]).find((x) => x.id === id);
  expect(q, 'the open question is listed').toBeDefined();
  return q?.plain;
};

describe('the plain text is written onto a question already pending', () => {
  it("sets `plain` on the open round from the asker's own token, and the Needs you decision reads it", async () => {
    const id = await pending();
    expect((await roundOf(id))?.plain).toBeUndefined();
    // the master finds it where the dispatch guide sends it: an open question reading `plain: null`
    expect(await listedPlain(id)).toBeNull();
    const r = await write(tok.asker, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id, round: 1, plain: PLAIN });
    expect((await roundOf(id))?.plain).toBe(PLAIN);
    expect(await listedPlain(id)).toBe(PLAIN);
    await settleOutbox();
    const read = await api(tok.owner, 'GET', `/api/projects/${projectId}/needs-you/decisions`);
    const decision = (read.body.decisions as Record<string, unknown>[]).find(
      (d) => d.id === `question:${id}`,
    );
    expect(decision?.plain).toBe(PLAIN);
  });

  it("is written by the project's master, an agent's credential that did not ask it", async () => {
    const id = await pending();
    const r = await write(tok.master, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await roundOf(id))?.plain).toBe(PLAIN);
  });

  it('is written by a project admin, and written again replaces what was there', async () => {
    const id = await pending();
    expect((await write(tok.asker, id, 'A first try.')).status).toBe(200);
    const r = await write(tok.owner, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await roundOf(id))?.plain).toBe(PLAIN);
  });
});

describe('the door refuses by name', () => {
  it('refuses a person member who did not ask it, naming the permission, and writes nothing', async () => {
    const id = await pending();
    const r = await write(tok.member, id);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(JSON.stringify(r.body)).toContain('project.admin');
    expect((await roundOf(id))?.plain).toBeUndefined();
  });

  it('refuses a settled question QUESTION_NOT_OPEN, and writes nothing', async () => {
    const id = await pending();
    const voided = await api(tok.owner, 'POST', `/api/questions/${id}/void`, {
      reason: 'No longer needed.',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const r = await write(tok.asker, id);
    expect(r.body.code, JSON.stringify(r.body)).toBe('QUESTION_NOT_OPEN');
    expect((await roundOf(id))?.plain).toBeUndefined();
  });

  it("answers another project's caller not found, and writes nothing", async () => {
    const id = await pending();
    const r = await write(tok.stranger, id);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect((await roundOf(id))?.plain).toBeUndefined();
  });

  it('refuses an empty plain text by its shape', async () => {
    const id = await pending();
    const r = await write(tok.asker, id, '   ');
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect((await roundOf(id))?.plain).toBeUndefined();
  });
});

describe('a round stored with a keyed steward label reads keyless (ISS-1006 round 2)', () => {
  it("names a merge's target by its title on the question read, its id unchanged", async () => {
    const id = await pending();
    const step = {
      round: 1,
      prompt: 'Open it, merge it into ISS-98, keep it as a draft, or drop it?',
      askedAt: new Date().toISOString(),
      answerShape: 'choice',
      options: [
        {
          id: 'steward.open',
          label: 'Open it: admit it for work',
          authority: 'writer',
          bindsTo: 'session',
          executedBy: 'core',
        },
        {
          id: 'steward.merge:ISS-98',
          label: 'Merge it into ISS-98: Declare the order read types',
          authority: 'writer',
          bindsTo: 'session',
          executedBy: 'core',
        },
      ],
      recommendedOptionId: 'steward.open',
    };
    await rows(
      sql`UPDATE agent_questions SET steps = ${JSON.stringify([step])}::jsonb WHERE id = ${id} RETURNING id`,
    );
    const read = await api(tok.owner, 'GET', `/api/questions/${id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const options = read.body.options as { id: string; label: string }[];
    expect(options.map((o) => [o.id, o.label])).toEqual([
      ['steward.open', 'Open it: admit it for work'],
      ['steward.merge:ISS-98', 'Merge it into: Declare the order read types'],
    ]);
  });
});

describe("a run's own option text is the run's words (ISS-1006 round 2: teach, never rewrite)", () => {
  it('lists a run question whose option names a key with that label as written', async () => {
    const id = randomUUID();
    const option = (oid: string, label: string) => ({
      id: oid,
      label,
      authority: 'writer' as const,
      bindsTo: 'session' as const,
      executedBy: 'agent' as const,
    });
    await askQuestion({
      id,
      projectId,
      askedBy: askerId,
      prompt: 'ISS-673 c1 failed again. Second fix round, or drop it?',
      blockerKind: 'human',
      answer: {
        shape: 'choice',
        options: [
          option('second-round', 'Build a second fix round'),
          option('drop', 'Drop ISS-673: the shipped change stays'),
        ],
        recommendedOptionId: 'second-round',
      },
    });
    await settleOutbox();
    const read = await api(tok.owner, 'GET', `/api/projects/${projectId}/needs-you/decisions`);
    const decision = (read.body.decisions as Record<string, unknown>[]).find(
      (d) => d.id === `question:${id}`,
    );
    expect((decision?.answers as { label: string }[] | undefined)?.map((a) => a.label)).toEqual([
      'Build a second fix round',
      'Drop ISS-673: the shipped change stays',
    ]);
  });
});
