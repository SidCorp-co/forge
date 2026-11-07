/**
 * ISS-1080, planted from epod ISS-97 (2026-11-07): an issue filed with its acceptance criteria only
 * under its description's Outcome read 0 criteria; the run landed it, and at `awaiting_release` a
 * write of its criteria was refused CRITERIA_LOCKED, so putting them on the record took a reopen
 * round-trip that read in its history as a defect.
 *
 * - a filing, and a write that takes the lease, on an issue with a criteria list in its description
 *   and none on the record answers a `criteria-list-in-description` warning naming the door;
 * - the run holding an issue that reached `awaiting_release` (or `closed`) with no criteria adds
 *   them once, without a reopen, recorded as added after landing, and a verdict then attaches;
 * - a second add, an add by anyone else, and any change to an issue that has criteria stay refused,
 *   each by name. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/late-add.ts
 * @direct-test-of packages/core/src/issues/criteria/description-criteria.ts
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria/routes.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 * @direct-test-of packages/core/src/issues/create-service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
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
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = 'cd34'.repeat(10);
const RULE = 'criteria-list-in-description';
const OUTCOME = `Found by the epod master on ISS-97.

**Outcome:**
- The order list loads in under 2 s.
- A clerk sees the new column.`;

let projectId = '';
let ownerId = '';
let holderId = '';
let unplant: (() => void) | null = null;
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

async function boxPat(userId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const deviceId = await createTestDevice(userId);
  return (await mintPat({ permissions: ['*'], userId, name, deviceId, projectIds: [projectId] }))
    .plaintext;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // two member agents' boxes: the run holding the issue, and another that does not
  holderId = (await createTestUser({ kind: 'agent' })).id;
  const other = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, holderId, 'member');
  await addProjectMember(projectId, other, 'member');
  call = requester(app, {
    holder: await boxPat(holderId, 'box-holder'),
    other: await boxPat(other, 'box-other'),
    owner: await userToken(ownerId),
  });
  unplant = plantLiveBuild(LIVE);
}, 120_000);

afterAll(async () => {
  unplant?.();
  await closeWorld();
});

let seq = 500;
/** An issue its run landed with the Outcome list in its description: at `status`, merged, with `criteria` live. */
async function landed(criteria: string[] = [], status = 'awaiting_release'): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`epod work ${seq}`}, ${OUTCOME}, ${status}, ${ownerId}, now())`);
  for (const [i, statement] of criteria.entries()) {
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})`);
  }
  return id;
}

const leaseBody = (who: string) => ({
  sessionContext: {
    lease: { holder: `epod-master-${who}`, renewedAt: new Date().toISOString(), minutes: 60 },
  },
});

const put = (id: string, statements: string[], who = 'holder') =>
  call(who, 'PUT', `/api/issues/${id}/criteria`, {
    criteria: statements.map((statement) => ({ statement })),
  });

const codesOf = (r: Reply): string[] =>
  (((r.json as Doc).error?.refusals ?? []) as Doc[]).map((x) => String(x.code));

const liveStatements = async (id: string) =>
  (
    await rows<{ statement: string }>(sql`
      SELECT statement FROM issue_criteria WHERE issue_id = ${id} AND retired_at IS NULL ORDER BY n`)
  ).map((r) => r.statement);

const addedAfterLanding = (id: string) =>
  rows<{ actor_id: string; payload: Doc; created_at: Date }>(sql`
    SELECT actor_id, payload, created_at FROM activity_log
     WHERE issue_id = ${id} AND action = 'issue.criteria.added_after_landing'`);

const warningsOf = (r: Reply): string[] => ((r.json as Doc).warnings ?? []) as string[];

describe('criteria only in the description are told before the lock (ISS-1080)', () => {
  it('tells a filing whose description lists criteria and records none, naming the door', async () => {
    const r = await call('holder', 'POST', `/api/projects/${projectId}/issues`, {
      title: 'Order list loads fast',
      description: OUTCOME,
    });
    const filed = ok(r, 201);
    const told = warningsOf(r).find((w) => w.startsWith(RULE));
    expect(told, JSON.stringify(filed)).toBeDefined();
    expect(told).toContain('2 items under "Outcome"');
    expect(told).toContain(`PUT /api/issues/${filed.id}/criteria`);
  });

  it('tells no filing that records them, as acceptanceCriteria on the create', async () => {
    const r = await call('holder', 'POST', `/api/projects/${projectId}/issues`, {
      title: 'Order list loads fast, criteria filed',
      description: OUTCOME,
      acceptanceCriteria: '1. The order list loads in under 2 s.\n2. A clerk sees the new column.',
    });
    const filed = ok(r, 201);
    expect(warningsOf(r).filter((w) => w.startsWith(RULE))).toEqual([]);
    expect(await liveStatements(String(filed.id))).toEqual([
      'The order list loads in under 2 s.',
      'A clerk sees the new column.',
    ]);
  });

  it('tells a write that takes the lease, and not one that renews it', async () => {
    const filed = ok(
      await call('owner', 'POST', `/api/projects/${projectId}/issues`, {
        title: 'Taken with criteria in prose',
        description: OUTCOME,
      }),
      201,
    );
    const taken = await call('holder', 'PATCH', `/api/issues/${filed.id}`, leaseBody('holder'));
    ok(taken);
    expect(warningsOf(taken).some((w) => w.startsWith(RULE)), JSON.stringify(taken.json)).toBe(
      true,
    );
    const renewed = await call('holder', 'PATCH', `/api/issues/${filed.id}`, {
      ...leaseBody('holder'),
      expect: { sessionContext: (taken.json as Doc).sessionContext },
    });
    ok(renewed);
    expect(warningsOf(renewed).filter((w) => w.startsWith(RULE))).toEqual([]);
  });
});

describe('the run holding a landed issue with no criteria adds them once (ISS-1080)', () => {
  it('adds them at awaiting_release without a reopen, records the add, and a verdict attaches', async () => {
    const id = await landed();
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await put(id, ['The order list loads in under 2 s.', 'A clerk sees the new column.']);
    ok(r);
    expect(await liveStatements(id)).toHaveLength(2);
    const [status] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
    expect(status?.status).toBe('awaiting_release');
    const added = await addedAfterLanding(id);
    expect(added).toHaveLength(1);
    expect(added[0]?.actor_id).toBe(holderId);
    expect(added[0]?.payload).toMatchObject({ status: 'awaiting_release', added: [1, 2] });
    expect(String(added[0]?.payload.holder)).toContain('epod-master-holder');
    const verdict = await call('owner', 'POST', `/api/issues/${id}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'the order list loaded in 1.2 s on the live build',
      identity: { kind: 'commit', sha: LIVE },
      evidence: ['orders.png'],
    });
    expect(verdict.status, JSON.stringify(verdict.json)).toBe(201);
  });

  it('refuses a second add by name, and keeps the first', async () => {
    const id = await landed();
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    ok(await put(id, ['The order list loads in under 2 s.']));
    const again = await put(id, ['The order list loads in under 2 s.', 'A third thing holds.']);
    expect(again.status).toBe(422);
    expect(codesOf(again)).toEqual(['CRITERIA_LATE_ADD_SPENT']);
    expect(await liveStatements(id)).toEqual(['The order list loads in under 2 s.']);
  });

  it('refuses an add by a box that does not hold the issue, and writes nothing', async () => {
    const id = await landed();
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await put(id, ['The order list loads in under 2 s.'], 'other');
    expect(r.status).toBe(422);
    expect(codesOf(r)).toEqual(['CRITERIA_LATE_ADD_NOT_HOLDER']);
    expect(JSON.stringify(r.json)).toContain('epod-master-holder');
    expect(await liveStatements(id)).toEqual([]);
    expect(await addedAfterLanding(id)).toEqual([]);
  });

  it('refuses an add where nothing holds the issue', async () => {
    const id = await landed();
    const r = await put(id, ['The order list loads in under 2 s.'], 'owner');
    expect(codesOf(r)).toEqual(['CRITERIA_LATE_ADD_NOT_HOLDER']);
  });

  it('keeps an issue that already has criteria locked, its holder included', async () => {
    const id = await landed(['The order list loads in under 2 s.']);
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await put(id, ['The order list loads in under 2 s.', 'A clerk sees the new column.']);
    expect(r.status).toBe(422);
    expect(codesOf(r)).toEqual(['CRITERIA_LOCKED']);
    expect(await addedAfterLanding(id)).toEqual([]);
  });

  it('keeps an issue locked whose criteria were all retired', async () => {
    const id = await landed(['The order list loads in under 2 s.']);
    await rows(sql`UPDATE issue_criteria SET retired_at = now() WHERE issue_id = ${id}`);
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await put(id, ['A clerk sees the new column.']);
    expect(codesOf(r)).toEqual(['CRITERIA_LOCKED']);
  });

  it('takes the add at closed through the text field, from the holder', async () => {
    const id = await landed([], 'closed');
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await call('holder', 'PATCH', `/api/issues/${id}`, {
      acceptanceCriteria: '1. The order list loads in under 2 s.',
    });
    ok(r);
    expect(await liveStatements(id)).toEqual(['The order list loads in under 2 s.']);
    expect(await addedAfterLanding(id)).toHaveLength(1);
  });

  it('keeps a dropped issue locked', async () => {
    const id = await landed([], 'dropped');
    ok(await call('holder', 'PATCH', `/api/issues/${id}`, leaseBody('holder')));
    const r = await put(id, ['The order list loads in under 2 s.']);
    expect(codesOf(r)).toEqual(['CRITERIA_LOCKED']);
  });
});
