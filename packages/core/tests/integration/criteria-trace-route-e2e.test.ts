/**
 * Tying an issue to business criteria of its requirement (`POST /api/issues/:id/criteria/traces`),
 * the agents' act on their tokens (REQ-68 BC-6; a person at the web is refused
 * CRITERIA_TRACE_ACT_FORBIDDEN, ISS-687 round 4): one appended criterion per BC, worded as
 * the BC is at the requirement's current revision and traced to that wording (a trace left on an
 * earlier wording is refreshed: coverage-newest-verdict-e2e.test.ts). A closed
 * issue takes it, and then takes a verdict on it, since verifying shipped work is the point. Wrong
 * input is refused by name, with nothing written. An existing line is tied by number, keeping its
 * verdicts, and an add of a code a line already words is refused naming it (ISS-1283). Through the
 * app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/routes.ts
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
  makeAgreeReady,
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
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }],
    [`/requirements/${key}/agree`, { revision: 1, reason: 'Agreed with the owner for this test.' }],
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
    const neither = await api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, {});
    expect(refusalCode(neither.body)?.code).toBe('CRITERIA_INPUT_INVALID');
    expect((await trace(issueId, ['BC-1'], viewerToken)).status).toBe(403);
    expect(await criteriaOf(issueId)).toHaveLength(0);
  });
});

// ISS-1283 (FB-711, epod ISS-187): an issue with proven criteria sent their codes meaning "tie mine"
// and got unjudged copies beside them, kept forever on a closed issue. A tie keeps the line and its
// verdict; an add of a code a line already words is refused naming it. Planted red: the add form's
// refusal taken out of `tie-plan.ts:planAdds`, the copy is written; on the code before, `ties` is
// refused at the door.
describe('a tie keeps an existing criterion and its verdicts; an add of one a line words is refused', () => {
  const tie = (issueId: string, ties: unknown, codes?: unknown) =>
    api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, {
      ties,
      ...(codes ? { codes } : {}),
    });

  /** A closed issue of `req` holding two criteria, the second passed on the shipped commit. */
  async function provenIssue(req: string, second: string): Promise<string> {
    const issueId = await closedIssueOf(req);
    await seedIssueStatus(issueId, 'in_progress');
    const put = await api(token, 'PUT', `/api/issues/${issueId}/criteria`, {
      criteria: [
        { n: 1, statement: 'The reminder lists every due dose' },
        { n: 2, statement: second },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await seedIssueStatus(issueId, 'closed');
    const v = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 2,
      verdict: 'pass',
      reason: 'Seen on the live deployment',
      identity: { kind: 'commit', sha: SHIPPED },
      evidence: ['report-1440.png'],
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return issueId;
  }

  it('ties line 2 of a closed issue to its BC, adding no line and keeping its verdict', async () => {
    const req = await agreedRequirement();
    const issueId = await provenIssue(req, 'The doctor opens the weekly report');
    const before = await criteriaOf(issueId);

    const r = await tie(issueId, [{ n: 2, code: 'BC-2' }]);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rows = (await criteriaOf(issueId)) as Array<Row & { id: string; latest: unknown }>;
    expect(rows.map((c) => [c.n, c.statement])).toEqual([
      [1, 'The reminder lists every due dose'],
      [2, `(${req} BC-2) The doctor opens the weekly report`],
    ]);
    expect(rows[1]?.id).toBe((before[1] as Row & { id: string }).id);
    expect(rows[1]?.requirementCriterionId).not.toBeNull();
    expect(rows[1]?.latest).toMatchObject({ verdict: 'pass', commitSha: SHIPPED });
    const history = await api(token, 'GET', `/api/issues/${issueId}/criteria/2`);
    expect(JSON.stringify(history.body)).toContain(`tied to ${req} BC-2, keeping its verdicts`);
    const detail = await onProject('GET', `/requirements/${req}`);
    const coverage = (
      detail.body as { standing: { coverage: Array<{ code: string; issues: unknown[] }> } }
    ).standing.coverage;
    expect(coverage.find((c) => c.code === 'BC-2')?.issues).toHaveLength(1);
  });

  it('refuses an add of a code a live line already words, naming that line and the tie', async () => {
    const req = await agreedRequirement();
    // the BC's words, in another case, wrapped and closed by a full stop
    const issueId = await provenIssue(req, 'a doctor sees   the Report.');

    const r = await trace(issueId, ['BC-1', 'BC-2']);

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalCode(r.body)).toMatchObject({
      code: 'CRITERIA_TRACE_WORDED',
      detail: expect.stringMatching(
        /criterion 2 already words .* BC-2 .*Tie that line instead, `\{ ties: \[\{ n: 2, code: 'BC-2' \}\] \}`/,
      ),
    });
    expect(await criteriaOf(issueId)).toHaveLength(2);
  });

  it('refuses a tie of a line that traces a BC, a line it does not hold, and a code another line traces', async () => {
    const req = await agreedRequirement();
    const issueId = await provenIssue(req, 'The doctor opens the weekly report');
    expect((await tie(issueId, [{ n: 2, code: 'BC-2' }])).status).toBe(201);

    const traced = await tie(issueId, [{ n: 2, code: 'BC-3' }]);
    const missing = await tie(issueId, [{ n: 7, code: 'BC-3' }]);
    const held = await tie(issueId, [{ n: 1, code: 'BC-2' }]);

    expect(refusalCode(traced.body)?.code).toBe('CRITERIA_TIE_TRACED');
    expect(refusalCode(missing.body)).toMatchObject({
      code: 'CRITERION_UNKNOWN',
      detail: expect.stringContaining('its live criteria are 1, 2'),
    });
    expect(refusalCode(held.body)).toMatchObject({
      code: 'CRITERIA_TRACE_DUPLICATE',
      detail: expect.stringContaining('already traced by criterion 2'),
    });
    expect((await criteriaOf(issueId)).map((c) => c.requirementCriterionId === null)).toEqual([
      true,
      false,
    ]);
  });

  it('ties one line and adds an unworded code in one call', async () => {
    const req = await agreedRequirement();
    const issueId = await provenIssue(req, 'The doctor opens the weekly report');

    const r = await tie(issueId, [{ n: 2, code: 'BC-2' }], ['BC-3']);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await criteriaOf(issueId)).map((c) => [c.n, c.statement])).toEqual([
      [1, 'The reminder lists every due dose'],
      [2, `(${req} BC-2) The doctor opens the weekly report`],
      [3, `(${req} BC-3) A patient can opt out`],
    ]);
  });
});

// ISS-687 round 4 (judge run d47d6de0 at dev.489, c3): ISS-639's Criteria section offered a person
// "Tie to REQ-66 criteria". The web's session cookie is refused by name, nothing is written, and the
// same person's token still ties. Planted red by taking `agentsTie` off the route: the web ties.
describe("a person at the web ties nothing: tying is the agents' act", () => {
  it('refuses the session cookie CRITERIA_TRACE_ACT_FORBIDDEN and writes nothing', async () => {
    const req = await agreedRequirement();
    const issueId = await closedIssueOf(req);

    const web = await api(
      null,
      'POST',
      `/api/issues/${issueId}/criteria/traces`,
      { codes: ['BC-1'] },
      { cookie: `forge_auth=${token}` },
    );

    expect(web.status, JSON.stringify(web.body)).toBe(403);
    expect(refusalCode(web.body)?.code).toBe('CRITERIA_TRACE_ACT_FORBIDDEN');
    expect(await criteriaOf(issueId)).toHaveLength(0);
    expect((await trace(issueId, ['BC-1'])).status).toBe(201);
  });
});
