/**
 * A business question about a requirement is asked with no issue (ISS-678, FB-149): `POST
 * /api/questions` takes `projectId` and `about` in place of `issueId`, as the box's door `POST
 * /api/devices/me/questions` already did, and a question asked through either reads back naming the
 * same requirement as its `subject`. It is listed on the requirement's page and on Needs you, and its
 * answer lands on the requirement as a decision. An ask on no issue that names no project or nothing
 * it is about is refused by name, as are `{ requirement: null }` with no issue to resolve it against
 * and a requirement the project does not hold, writing nothing; an ask on an issue is unchanged.
 */

// @direct-test-of packages/core/src/questions/routes.ts
// @direct-test-of packages/core/src/questions/ask.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  refusalCodes,
  requester,
  settleOutbox,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let w: EcosystemWorld;
let projectId: string;
let ownerId: string;
let say: (
  who: 'owner' | 'master' | 'box',
  method: string,
  path: string,
  body?: Doc,
) => Promise<Reply>;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  projectId = w.project.forge;
  ownerId = w.user.platform;
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  say = requester(w.app, {
    owner: w.token.platform,
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
    box: (
      await mintPat({
        userId: ownerId,
        name: deviceTokenNameFor(deviceId),
        permissions: ['*'],
        deviceId,
      })
    ).plaintext,
  });
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

async function requirement(title: string): Promise<{ id: string; key: string; title: string }> {
  const made = ok(
    await say('owner', 'POST', `/api/projects/${projectId}/requirements`, {
      title,
      reason: 'the clinic asked',
      spec: { goal: title },
      criteria: [{ body: 'A referral manager sees the referrals they made.' }],
    }),
    201,
  );
  return { id: made.id as string, key: made.key as string, title };
}

let seq = 700;
async function plantIssue(requirementId: string | null): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, requirement_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${seq}`}, 'in_progress', ${ownerId}, ${requirementId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

const choice = {
  options: [
    { id: 'yes', label: 'Yes', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
    { id: 'no', label: 'No', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
  ],
  recommendedOptionId: 'no',
};

/** A business question through the REST door, as the master. */
const askRest = (body: Doc) =>
  say('master', 'POST', '/api/questions', {
    prompt: 'May a referral manager download the aggregate report?',
    ...choice,
    ...body,
  });

/** The same question through the box's door, which a `forge-runner question ask` sends. */
const askBox = (body: Doc) =>
  say('box', 'POST', '/api/devices/me/questions', {
    id: randomUUID(),
    projectId,
    runId: randomUUID(),
    prompt: 'May a referral manager download the aggregate report?',
    blockerKind: 'human',
    ...choice,
    ...body,
  });

const questionCount = async () =>
  Number(
    (await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM agent_questions`))[0]?.n ?? 0,
  );

const storedRow = async (id: string) =>
  (
    await rows<{ issue_id: string | null; requirement_id: string | null; about: Doc | null }>(
      sql`SELECT issue_id, requirement_id, about FROM agent_questions WHERE id = ${id}`,
    )
  )[0];

describe('a question about a requirement is asked on no issue', () => {
  it('is written by POST /api/questions with projectId and about, and stores the requirement as its subject', async () => {
    const req = await requirement('Referral managers see their referrals');
    const asked = ok(await askRest({ projectId, about: { requirement: req.key } }), 201);
    const stored = await storedRow(asked.id as string);
    expect(stored).toEqual({
      issue_id: null,
      requirement_id: null,
      about: { kind: 'requirement', requirementId: req.id },
    });
    const one = ok(await say('owner', 'GET', `/api/questions/${asked.id}`));
    expect(one.subject).toEqual({ kind: 'requirement', key: req.key, title: req.title });
    expect(one.issueId ?? null).toBeNull();
  });

  it('reads back the same subject whichever door asked it', async () => {
    const req = await requirement('Aggregate report download');
    const rest = ok(await askRest({ projectId, about: { requirement: req.key } }), 201);
    const box = ok(await askBox({ about: { requirement: req.key } }));
    const subjects = await Promise.all(
      [rest.id, box.questionId].map(
        async (id) => ok(await say('owner', 'GET', `/api/questions/${id}`)).subject,
      ),
    );
    const subject = { kind: 'requirement', key: req.key, title: req.title };
    expect(subjects).toEqual([subject, subject]);
    expect((await storedRow(box.questionId as string))?.about).toEqual(
      (await storedRow(rest.id as string))?.about,
    );
  });

  it('is listed on the requirement page and on Needs you, and its answer is a decision there', async () => {
    const req = await requirement('Referrer feedback consent');
    const asked = ok(await askRest({ projectId, about: { requirement: req.id } }), 201);
    const page = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}`),
    );
    const listed = (page.questions as Doc[]).find((q) => q.id === asked.id);
    expect(listed, JSON.stringify(page.questions)).toMatchObject({ status: 'open' });

    await settleOutbox();
    const needs = ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`));
    const decision = (needs.decisions as Doc[]).find((d) => d.key === asked.id);
    expect(decision, JSON.stringify(needs.decisions.map((d: Doc) => d.key))).toBeDefined();
    expect(decision?.subject).toEqual({ kind: 'requirement', key: req.key, title: req.title });

    ok(
      await say('owner', 'POST', `/api/questions/${asked.id}/answer`, { round: 1, optionId: 'no' }),
    );
    const rolled = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}/decisions`),
    );
    const recorded = (rolled.decisions as Doc[]).find(
      (d) => (d.decision as Doc | null)?.decision === 'No',
    );
    expect(recorded, JSON.stringify(rolled.decisions)).toBeDefined();
    expect((recorded as Doc).target).toMatchObject({ scope: 'requirement', key: req.key });
  });

  it('takes a contract the project publishes as its subject too', async () => {
    const asked = ok(await askRest({ projectId, about: { contract: 'forge/forge-api' } }), 201);
    const one = ok(await say('owner', 'GET', `/api/questions/${asked.id}`));
    expect(one.subject).toEqual({ kind: 'contract', key: 'forge/forge-api' });
  });
});

describe('an ask on no issue that cannot name its subject is refused by name and writes nothing', () => {
  async function refused(body: Doc, codes: string[], status = 400) {
    const before = await questionCount();
    const r = await askRest(body);
    expect(r.status, JSON.stringify(r.json)).toBe(status);
    expect(refusalCodes(r).sort(), JSON.stringify(r.json)).toEqual([...codes].sort());
    expect(await questionCount()).toBe(before);
    return r;
  }

  it('refuses no about, naming the field and the shapes it takes', async () => {
    const r = await refused({ projectId }, ['QUESTION_SUBJECT_REQUIRED']);
    const row = (r.json.error.refusals as Doc[])[0];
    expect(row?.path).toBe('/about');
    expect(row?.detail).toContain('{"requirement":"REQ-n"}');
  });

  it('refuses no project, and names both gaps at once when both are missing', async () => {
    const req = await requirement('No project named');
    const r = await refused({ about: { requirement: req.key } }, ['QUESTION_PROJECT_REQUIRED']);
    expect((r.json.error.refusals as Doc[])[0]?.path).toBe('/projectId');
    await refused({}, ['QUESTION_PROJECT_REQUIRED', 'QUESTION_SUBJECT_REQUIRED']);
  });

  it('refuses { requirement: null }, which has no issue to resolve against', async () => {
    const r = await refused(
      { projectId, about: { requirement: null } },
      ['QUESTION_ABOUT_NO_REQUIREMENT'],
      422,
    );
    expect((r.json.error.refusals as Doc[])[0]?.detail).toContain('asked on no issue');
  });

  it('refuses a requirement the project does not hold', async () => {
    await refused(
      { projectId, about: { requirement: 'REQ-9999' } },
      ['QUESTION_ABOUT_UNKNOWN'],
      422,
    );
  });

  it('refuses a bare key, the one about shape both doors share', async () => {
    await refused({ projectId, about: 'REQ-1' }, ['QUESTION_ABOUT_SHAPE']);
  });

  it('answers a project the caller cannot reach as not found', async () => {
    const before = await questionCount();
    const r = await askRest({ projectId: w.project.store, about: { requirement: 'REQ-1' } });
    expect(r.status, JSON.stringify(r.json)).toBe(404);
    expect(await questionCount()).toBe(before);
  });
});

describe('an ask on an issue is the ask it was', () => {
  it('takes about beside the issue and resolves { requirement: null } to what the issue delivers', async () => {
    const req = await requirement('Issue ask unchanged');
    const issue = await plantIssue(req.id);
    const asked = ok(await askRest({ issueId: issue.id, about: { requirement: null } }), 201);
    expect(await storedRow(asked.id as string)).toEqual({
      issue_id: issue.id,
      requirement_id: null,
      about: { kind: 'requirement', requirementId: req.id },
    });
  });

  it('asks on an issue with no about, as before', async () => {
    const issue = await plantIssue(null);
    const asked = ok(await askRest({ issueId: issue.id }), 201);
    expect((await storedRow(asked.id as string))?.about).toBeNull();
  });

  it('refuses a projectId that is not the issue’s own', async () => {
    const issue = await plantIssue(null);
    const r = await askRest({ issueId: issue.id, projectId: w.project.internal });
    expect(refusalCodes(r), JSON.stringify(r.json)).toContain('QUESTION_ISSUE_ELSEWHERE');
  });
});
