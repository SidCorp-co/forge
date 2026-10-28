/**
 * A dropped requirement is terminal, so it takes no revision: forge-dev REQ-9, dropped, answered a
 * new revision 200 and stood with a draft r2 nobody could remove (REQ-41 BC-12 had withdrawal only
 * through a steward's question). Refused by name now, the drop withdraws the draft it held, and an
 * open draft is withdrawn by a door of its own: by its author, or by a holder of
 * requirements.approve. Then forge-dev REQ-5 r5's accept sequence: every goal gap is named at once,
 * and adding "Value:" never takes away the problem its unlabelled first line states.
 *
 * @direct-test-of packages/core/src/requirements/service.ts
 * @direct-test-of packages/core/src/requirements/revision-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusalCodes,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';

let say: (who: 'owner' | 'member', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown, who: 'owner' | 'member' = 'owner') =>
  say(who, method, at(path), body);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const member = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, member, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(member),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A requirement agreed at r1, as REQ-9 was before it was dropped. */
async function agreed(title: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }));
  ok(
    await as('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed for this test.',
    }),
  );
  return key;
}

const revise = (key: string, base: number, who: 'owner' | 'member' = 'owner') =>
  as(
    'POST',
    `/requirements/${key}/revisions`,
    {
      baseRevision: base,
      reason: 'a wording to change',
      criteria: [{ code: 'BC-1', body: 'A saved board shows every card it had, in order.' }],
    },
    who,
  );

const revisions = async (key: string) =>
  rows<{ revision: number; state: string; withdrawn_reason: string | null }>(sql`
    SELECT rr.revision, rr.state, rr.withdrawn_reason FROM requirement_revisions rr
      JOIN requirements r ON r.id = rr.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))}
     ORDER BY rr.revision`);

describe('a dropped requirement takes no revision (forge-dev REQ-9)', () => {
  it('refuses a new revision by name, naming the status and the act that carries the work', async () => {
    const key = await agreed('Boards print themselves');
    ok(await as('POST', `/requirements/${key}/drop`, { reason: 'printing left the product' }));

    const res = await revise(key, 1);

    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(refusalCodes(res)).toEqual(['REQUIREMENT_DROPPED']);
    const detail = (res.json as Doc).error.refusals[0].detail as string;
    expect(detail).toContain(`${key} is dropped, and dropped is terminal`);
    expect(detail).toContain('POST /api/projects/:id/requirements');
    expect((await revisions(key)).map((r) => r.revision)).toEqual([1]);
  });

  it('withdraws the draft a requirement held when it is dropped, with the drop’s reason', async () => {
    const key = await agreed('Boards export to paper');
    ok(await revise(key, 1));

    ok(await as('POST', `/requirements/${key}/drop`, { reason: 'paper left the product' }));

    expect(await revisions(key)).toEqual([
      { revision: 1, state: 'current', withdrawn_reason: null },
      {
        revision: 2,
        state: 'withdrawn',
        withdrawn_reason: 'the requirement was dropped: paper left the product',
      },
    ]);
  });

  it('refuses rewriting, proposing or accepting a draft a dropped requirement still holds, and lets it be withdrawn', async () => {
    const key = await agreed('Boards fax themselves');
    ok(await revise(key, 1));
    // REQ-9's shape: dropped while its draft r2 stood, as the silence left it
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE requirements SET status = 'dropped'
                      WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`),
    );

    const rewrite = await as('PUT', `/requirements/${key}/revisions/2`, {
      reason: 'again',
      criteria: [{ code: 'BC-1', body: 'A saved board shows every card.' }],
    });
    expect(refusalCodes(rewrite)).toEqual(['REQUIREMENT_DROPPED']);
    expect(refusalCodes(await as('POST', `/requirements/${key}/revisions/2/propose`, {}))).toEqual([
      'REQUIREMENT_DROPPED',
    ]);

    ok(
      await as('POST', `/requirements/${key}/revisions/2/withdraw`, {
        reason: 'written on a dropped requirement',
      }),
    );
    expect((await revisions(key))[1]).toMatchObject({
      state: 'withdrawn',
      withdrawn_reason: 'written on a dropped requirement',
    });
  });
});

describe('withdrawing an open draft revision', () => {
  it('frees the one open revision, so the next revision is written', async () => {
    const key = await agreed('Boards sort by colour');
    ok(await revise(key, 1));
    expect(refusalCodes(await revise(key, 1))).toEqual(['REQUIREMENT_REVISION_OPEN']);

    ok(await as('POST', `/requirements/${key}/revisions/2/withdraw`, { reason: 'wrong wording' }));

    expect(ok(await revise(key, 1)).currentRevision).toBe(1);
    expect((await revisions(key)).map((r) => `${r.revision}:${r.state}`)).toEqual([
      '1:current',
      '2:withdrawn',
      '3:draft',
    ]);
  });

  it('refuses a draft someone else wrote to a member without requirements.approve, and its author takes it back', async () => {
    const key = await agreed('Boards sort by size');
    ok(await revise(key, 1, 'member'));

    const owners = await as('POST', `/requirements/${key}/revisions/2/withdraw`, {
      reason: 'the owner may',
    });
    expect(owners.status, JSON.stringify(owners.json)).toBe(200);

    ok(await revise(key, 1));
    const members = await as(
      'POST',
      `/requirements/${key}/revisions/3/withdraw`,
      { reason: 'not mine to withdraw' },
      'member',
    );
    expect(members.status, JSON.stringify(members.json)).toBe(403);
    expect(refusalCodes(members)).toEqual(['PERMISSION_FORBIDDEN']);
    expect((await revisions(key))[2]?.state).toBe('draft');
  });

  it('refuses a revision that is not a draft, and a withdraw that says no why', async () => {
    const key = await agreed('Boards sort by date');
    expect(
      refusalCodes(await as('POST', `/requirements/${key}/revisions/1/withdraw`, { reason: 'x' })),
    ).toEqual(['REQUIREMENT_REVISION_NOT_DRAFT']);
    ok(await revise(key, 1));
    expect(
      refusalCodes(await as('POST', `/requirements/${key}/revisions/2/withdraw`, { reason: ' ' })),
    ).toEqual(['REVISION_REASON_REQUIRED']);
    expect((await revisions(key))[1]?.state).toBe('draft');
  });
});

// forge-dev REQ-5 r5, 2026-10-28: the first accept was refused for value and measured only; with
// "Value:" and "Measured by:" added, the next was refused for the problem
describe('an accept refused for its goal names every gap at once', () => {
  it('refuses value and measured together, then accepts once they are added, the problem still read', async () => {
    const opening = 'Referral managers lose referrals between intake and triage.';
    // REQ-5 is agreed, so accepting its new head re-baselines and reads the ready checklist
    const key = await agreed('Referrals reach triage');
    const body = (goal: string) => ({
      reason: 'the goal as written',
      spec: { goal, personas: ['Referral manager'] },
      criteria: [{ code: 'BC-1', body: 'A saved board shows every card it had.' }],
    });
    ok(await as('POST', `/requirements/${key}/revisions`, { baseRevision: 1, ...body(opening) }));
    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));

    const first = await as('POST', `/requirements/${key}/revisions/2/accept`, { reason: 'Accepted for this test.' });
    expect(first.status, JSON.stringify(first.json)).toBe(422);
    const paths = ((first.json as Doc).error.refusals as Doc[]).map((r) => r.path as string);
    expect(paths.filter((p) => /^\/answers\/(problem|value|measured)$/.test(p))).toEqual([
      '/answers/value',
      '/answers/measured',
    ]);

    ok(await as('POST', `/requirements/${key}/revisions/2/return`, { reason: 'add the value' }));
    ok(
      await as(
        'PUT',
        `/requirements/${key}/revisions/2`,
        body(
          `${opening}\nValue: every referral reaches a clinician.\nMeasured by: lost referrals per month.`,
        ),
      ),
    );
    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));

    const second = await as('POST', `/requirements/${key}/revisions/2/accept`, { reason: 'Accepted for this test.' });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
  });
});
