/**
 * Tying an issue to business criteria of its requirement (`POST /api/issues/:id/criteria/traces`),
 * the act a person takes from the issue's Criteria tab: one appended criterion per BC, worded as
 * the BC is at the requirement's current revision and traced to that wording (a trace left on an
 * earlier wording is refreshed: coverage-newest-verdict-e2e.test.ts). A closed
 * issue takes it, and then takes a verdict on it, since verifying shipped work is the point. Wrong
 * input is refused by name, with nothing written. Through the app's own routes, against real
 * Postgres.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';

const SHIPPED = '0d91ae7c74f70295ede115463b17559e650b5207';

let projectId: string;
let ownerId: string;
let token: string;
let viewerToken: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  const viewer = await createTestUser({ verified: true });
  await addProjectMember(projectId, viewer.id, 'viewer');
  viewerToken = await userToken(viewer.id);
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function agreedRequirement(): Promise<string> {
  const created = await onProject('POST', '/requirements', {
    title: 'Reminders',
    reason: 'planted',
    criteria: [
      { body: 'A nurse sees the reminder' },
      { body: 'A doctor sees the report' },
      { body: 'A patient can opt out' },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = String(created.body.key);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1 }],
  ] as const) {
    const r = await onProject('POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  return key;
}

/** A closed issue delivering `req`, linked through the requirement's own route. */
async function closedIssueOf(req: string | null, seq = 1): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  if (req) {
    const linked = await onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` });
    expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300);
  }
  return id;
}

const trace = (issueId: string, codes: unknown, as = token) =>
  api(as, 'POST', `/api/issues/${issueId}/criteria/traces`, { codes });

type Row = { n: number; statement: string; requirementCriterionId: string | null };
const criteriaOf = async (issueId: string) => {
  const r = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.criteria as Row[];
};

const refusalCode = (body: Record<string, unknown>) =>
  (body.error as { refusals?: Array<{ code: string; detail: string }> } | undefined)?.refusals?.[0];

describe('a person ties an issue to business criteria of its requirement', () => {
  it('appends one criterion per BC, worded as the BC and traced to it, on a closed issue', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);

    const r = await trace(issueId, ['BC-1', 'BC-3']);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rows = await criteriaOf(issueId);
    expect(rows.map((c) => [c.n, c.statement])).toEqual([
      [1, `(${req} BC-1) A nurse sees the reminder`],
      [2, `(${req} BC-3) A patient can opt out`],
    ]);
    expect(rows.every((c) => c.requirementCriterionId !== null)).toBe(true);
    const [issue] = [
      ...(await db.execute(sql`SELECT acceptance_criteria FROM issues WHERE id = ${issueId}`)),
    ];
    expect((issue as { acceptance_criteria: string }).acceptance_criteria).toBe(
      `1. (${req} BC-1) A nurse sees the reminder\n2. (${req} BC-3) A patient can opt out`,
    );
  });

  it("shows on the requirement's coverage as the issue that traces each BC", async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);
    expect((await trace(issueId, ['BC-2'])).status).toBe(201);

    const detail = await onProject('GET', `/requirements/${req}`);

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const coverage = (
      detail.body as { standing: { coverage: Array<{ code: string; issues: unknown[] }> } }
    ).standing.coverage;
    expect(coverage.find((c) => c.code === 'BC-2')?.issues).toHaveLength(1);
    expect(coverage.find((c) => c.code === 'BC-1')?.issues).toHaveLength(0);
  });

  it('numbers after the criteria the issue already has and keeps them as they were', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);
    await seedIssueStatus(issueId, 'in_progress');
    const put = await api(token, 'PUT', `/api/issues/${issueId}/criteria`, {
      criteria: [{ n: 4, statement: 'the plan step wrote this' }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await seedIssueStatus(issueId, 'closed');

    expect((await trace(issueId, ['BC-2'])).status).toBe(201);

    expect((await criteriaOf(issueId)).map((c) => [c.n, c.statement])).toEqual([
      [4, 'the plan step wrote this'],
      [5, `(${req} BC-2) A doctor sees the report`],
    ]);
  });

  it('then takes a verdict on the traced criterion of the closed issue', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);
    expect((await trace(issueId, ['BC-1'])).status).toBe(201);

    const v = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'Seen on the live deployment',
      identity: { kind: 'commit', sha: SHIPPED },
      evidence: ['reminder-1440.png'],
    });

    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await criteriaOf(issueId))[0]).toMatchObject({
      n: 1,
      latest: { verdict: 'pass', commitSha: SHIPPED, evidence: ['reminder-1440.png'] },
    });
  });
});

describe('wrong input is refused by name and writes nothing', () => {
  it('refuses a BC the issue already traces, naming the criterion that holds it', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);
    expect((await trace(issueId, ['BC-1'])).status).toBe(201);

    const r = await trace(issueId, ['BC-2', 'BC-1']);

    expect(r.status).toBe(422);
    expect(refusalCode(r.body)).toMatchObject({
      code: 'CRITERIA_TRACE_DUPLICATE',
      detail: expect.stringContaining('already traced by criterion 1'),
    });
    expect(await criteriaOf(issueId)).toHaveLength(1);
  });

  it('refuses a code the requirement has no wording of', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);

    const r = await trace(issueId, ['BC-9']);

    expect(r.status).toBe(422);
    expect(refusalCode(r.body)).toMatchObject({
      code: 'CRITERIA_TRACE_UNRESOLVED',
      detail: expect.stringContaining('no wording of BC-9 live at revision 1'),
    });
    expect(await criteriaOf(issueId)).toHaveLength(0);
  });

  it('refuses a code that is not BC-<n>, and one sent twice', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);

    const shape = await trace(issueId, ['bc1']);
    const twice = await trace(issueId, ['BC-1', 'BC-1']);

    expect(refusalCode(shape.body)?.code).toBe('CRITERIA_TRACE_INVALID');
    expect(refusalCode(twice.body)).toMatchObject({
      code: 'CRITERIA_INPUT_INVALID',
      detail: 'BC-1 is sent twice',
    });
    expect(await criteriaOf(issueId)).toHaveLength(0);
  });

  it('refuses an issue that serves no requirement, and a dropped one', async () => {
    const req = await agreedRequirement();
    const unlinked = await closedIssueOf(null, 1);
    const dropped = await closedIssueOf(req, 2);
    await seedIssueStatus(dropped, 'dropped');

    const none = await trace(unlinked, ['BC-1']);
    const gone = await trace(dropped, ['BC-1']);

    expect(refusalCode(none.body)).toMatchObject({
      code: 'CRITERIA_TRACE_UNRESOLVED',
      detail: expect.stringContaining('serves no requirement'),
    });
    expect(refusalCode(gone.body)?.code).toBe('CRITERIA_LOCKED');
  });

  it('refuses an empty list at the door, and a viewer who may not write', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);

    expect((await trace(issueId, [])).status).toBe(400);
    expect((await trace(issueId, ['BC-1'], viewerToken)).status).toBe(403);
    expect(await criteriaOf(issueId)).toHaveLength(0);
  });
});
