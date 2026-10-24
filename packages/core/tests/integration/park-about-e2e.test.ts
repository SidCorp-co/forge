/**
 * A `needs_info` park names what its question is about (ISS-583, FB-148): the park takes `about` in
 * the three shapes `POST /api/questions` takes, the question it mints stores it, every read a person
 * answers from names it as `subject` (the question, the park, the Needs you decision), and the answer
 * lands on the requirement as a decision. A wrong `about` is refused by the codes the questions route
 * refuses it with, writing nothing; a park with no `about` is the park it was.
 */

// @direct-test-of packages/core/src/issues/transition.ts
// @direct-test-of packages/core/src/issues/park-question.ts
// @direct-test-of packages/core/src/issues/park-view.ts
// @direct-test-of packages/core/src/questions/write.ts
// @direct-test-of packages/core/src/questions/subject.ts
// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts

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
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';

let w: EcosystemWorld;
let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  projectId = w.project.forge;
  ownerId = w.user.platform;
  const { mintPat } = await import('../../src/credentials/pat.js');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(w.app, {
    owner: w.token.platform,
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
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

let seq = 500;
/** An issue planted at `in_progress`, delivering `requirementId` where one is named. */
async function plantIssue(
  requirementId: string | null = null,
): Promise<{ id: string; key: string }> {
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

const park = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus: 'needs_info',
    reason: 'May a referral manager download the aggregate report?',
    waitingKind: 'needs_decision',
    needs: 'yes or no, and who decided',
    ...body,
  });

type Asked = { id: string; status: string; about: Doc | null };
const questionsOn = (issueId: string) =>
  rows<Asked>(sql`
    SELECT id, status, about FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const statusOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}`)).status as string;

/** The one open question a park minted, as the question read, the issue's list and the park read show it. */
async function readsOf(issueId: string) {
  const [asked] = await questionsOn(issueId);
  expect(asked, 'the park minted no question').toBeDefined();
  const one = ok(await say('owner', 'GET', `/api/questions/${asked?.id}`));
  const listed = (
    ok(await say('owner', 'GET', `/api/questions?issueId=${issueId}`)).questions as Doc[]
  ).find((q) => q.id === asked?.id);
  const parked = ok(await say('owner', 'GET', `/api/issues/${issueId}/park`)).park as Doc;
  return { asked: asked as Asked, one, listed, parked };
}

describe('a park names the requirement its question is about', () => {
  it('records the requirement the issue delivers as the subject of the question it mints, and every read shows it', async () => {
    const req = await requirement('Referral managers see their referrals');
    const issue = await plantIssue(req.id);
    ok(await park(issue.id, { about: { requirement: null } }));
    expect(await statusOf(issue.id)).toBe('needs_info');

    const { asked, one, listed, parked } = await readsOf(issue.id);
    expect(asked).toMatchObject({
      status: 'open',
      about: { kind: 'requirement', requirementId: req.id },
    });
    const subject = { kind: 'requirement', key: req.key, title: req.title };
    expect(one.subject).toEqual(subject);
    expect(listed?.subject).toEqual(subject);
    expect(parked.subjects).toEqual([subject]);
  });

  it('records another requirement named by its key, on an issue that delivers none', async () => {
    const req = await requirement('Clinic owners export the aggregate');
    const issue = await plantIssue(null);
    ok(await park(issue.id, { about: { requirement: req.key } }));
    const { asked, one } = await readsOf(issue.id);
    expect(asked.about).toEqual({ kind: 'requirement', requirementId: req.id });
    expect(one.subject).toEqual({ kind: 'requirement', key: req.key, title: req.title });
  });

  it('records a contract the project publishes', async () => {
    const issue = await plantIssue(null);
    ok(await park(issue.id, { about: { contract: 'forge/forge-api' } }));
    const { asked, one, parked } = await readsOf(issue.id);
    expect(asked.about).toEqual({ kind: 'contract', contract: 'forge/forge-api' });
    expect(one.subject).toEqual({ kind: 'contract', key: 'forge/forge-api' });
    expect(parked.subjects).toEqual([{ kind: 'contract', key: 'forge/forge-api' }]);
  });

  it('asks its question with needs left out, and the answer lands on the requirement as a decision', async () => {
    const req = await requirement('Referrer feedback consent');
    const issue = await plantIssue(req.id);
    ok(await park(issue.id, { about: { requirement: null }, needs: undefined }));
    const { asked } = await readsOf(issue.id);
    ok(
      await say('owner', 'POST', `/api/questions/${asked.id}/answer`, {
        round: 1,
        text: 'No: the clinic owner keeps it.',
      }),
    );
    const rolled = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}/decisions`),
    );
    const decision = (rolled.decisions as Doc[]).find(
      (d) => (d.decision as Doc | null)?.decision === 'No: the clinic owner keeps it.',
    );
    expect(decision, JSON.stringify(rolled.decisions)).toBeDefined();
    expect((decision as Doc).target).toMatchObject({ scope: 'requirement', key: req.key });
    expect((decision as Doc).decision.reason).toContain(issue.key);
  });

  it('shows the requirement on the Needs you decision a person answers it from', async () => {
    const req = await requirement('Aggregate report download');
    const issue = await plantIssue(req.id);
    ok(await park(issue.id, { about: { requirement: null } }));
    await settleOutbox();
    const read = ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`));
    const decision = (read.decisions as Doc[]).find((d) => d.opens?.key === issue.key);
    expect(decision, JSON.stringify(read.decisions.map((d: Doc) => d.id))).toBeDefined();
    expect(decision?.subject).toEqual({ kind: 'requirement', key: req.key, title: req.title });
  });
});

describe('a wrong about on a park is refused by name and writes nothing', () => {
  async function refusedPark(
    issueId: string,
    body: Doc,
    code: string,
    who: 'owner' | 'master' = 'master',
  ) {
    const r = await park(issueId, body, who);
    expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
    expect(refusalCodes(r), JSON.stringify(r.json)).toContain(code);
    expect(await statusOf(issueId)).toBe('in_progress');
    expect(await questionsOn(issueId)).toEqual([]);
    return r;
  }

  it('refuses a bare key, the shape the questions route refuses', async () => {
    const issue = await plantIssue(null);
    const r = await refusedPark(issue.id, { about: 'REQ-1' }, 'QUESTION_ABOUT_SHAPE');
    const row = (r.json.error.refusals as Doc[]).find((x) => x.code === 'QUESTION_ABOUT_SHAPE');
    expect(row?.path).toBe('/about');
    expect(row?.detail).toContain('{"requirement":"REQ-n"}');
  });

  it('refuses a requirement this project does not hold, and a null one on an issue that delivers none', async () => {
    const issue = await plantIssue(null);
    await refusedPark(issue.id, { about: { requirement: 'REQ-9999' } }, 'QUESTION_ABOUT_UNKNOWN');
    await refusedPark(issue.id, { about: { requirement: null } }, 'QUESTION_ABOUT_NO_REQUIREMENT');
    await refusedPark(issue.id, { about: { contract: 'kho/api' } }, 'QUESTION_ABOUT_UNKNOWN');
  });

  it('refuses about on a park that waits on a merge mark or a design decision', async () => {
    const req = await requirement('Merge wait');
    const issue = await plantIssue(req.id);
    const other = await plantIssue(null);
    await refusedPark(
      issue.id,
      { about: { requirement: null }, awaitsMerge: { issueId: other.id }, needs: undefined },
      'QUESTION_ABOUT_ON_MERGE_WAIT',
    );
    await refusedPark(
      issue.id,
      {
        about: { requirement: null },
        awaitsDesign: { workflowId: randomUUID(), revision: 1 },
        needs: undefined,
      },
      'QUESTION_ABOUT_ON_DESIGN_WAIT',
    );
  });

  it('refuses about off a needs_info park and on a person credential, as needs is refused', async () => {
    const req = await requirement('Not a park');
    const issue = await plantIssue(req.id);
    const r = await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'on_hold',
      reason: 'paused',
      about: { requirement: null },
    });
    expect(refusalCodes(r), JSON.stringify(r.json)).toContain('NEEDS_NOT_APPLICABLE');
    await refusedPark(
      issue.id,
      { about: { requirement: null }, needs: undefined },
      'NEEDS_NOT_APPLICABLE',
      'owner',
    );
  });
});

describe('a park with no about', () => {
  it('mints its question as before, about nothing, and every read says none', async () => {
    const req = await requirement('Unchanged park');
    const issue = await plantIssue(req.id);
    ok(await park(issue.id, {}));
    const { asked, one, parked } = await readsOf(issue.id);
    expect(asked.about).toBeNull();
    expect(one.subject).toBeNull();
    expect(parked.subjects).toEqual([]);
  });
});
